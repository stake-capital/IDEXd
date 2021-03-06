import '@babel/polyfill';

import express from 'express';
import http from 'http';
import https from 'https';
import compression from 'compression';
import moment from 'moment';
import request from 'request-promise';
import config from './config';
import Db from './db';
import Routes from './routes';
import Worker from './worker';
import { keepAliveHeaders } from './shared';
import migrate from './migrate';
import { web3, waitForRpc } from './helpers';
import { IDEX_FIRST_BLOCK } from './constants';
import * as Sentry from '@sentry/node';

if (process.env.DISABLE_SENTRY !== '1') {
  Sentry.init({
    dsn: 'https://2c0043771883437e874c7a2e28fcbd1b@sentry.io/1352235',
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV,
    beforeSend: function (data) {
      if (Math.random() < 0.9) return null;
      const exception = data.exception;
      if (exception && exception.values && exception.values.length > 0) {
        const errorMessage = exception.values[0].value;
        if (errorMessage.match(/^BatchRequest error/)) {
          console.log('Blocked a BatchRequest error from Sentry');
          return null;
        }
      }
      return data;
    }
  });
}

const fs = require('fs').promises;

const AURAD_VERSION = require('../package.json').version;
const MAX_OFFLINE_TIME = 3*60*1000;

const db = new Db();
const app = express();

let server;
let coldWallet;
let account;
let worker;

const buildServer = async () => {
  if (process.env.SSL === '1') {
    const privateKeyPath = process.env.SSL_PRIVATE_KEY_PATH;
    const privateKey = await fs.readFile(privateKeyPath, 'utf8');

    const certificatePath = process.env.SSL_CERT_PATH;
    const certificate = await fs.readFile(certificatePath, 'utf8');

    const credentials = {
      key: privateKey,
      cert: certificate,
    };
    server = https.createServer(credentials, app);
  } else {
    server = http.createServer(app);
  }
};

const routes = new Routes(app, db);
app.use(compression());

let hasBeenOnline = false;
let timeSinceLastBlockUpdate = 0;
let previousWorkerBlock = 0;
let previousWorkerBlockTime = Date.now();

const keepalive = async () => {
  try {
    if (coldWallet) {
      const timestamp = Date.now();

      const json = {
        version: AURAD_VERSION,
        blockNumber: worker.currentBlock,
        timestamp,
      };

      const challenge = process.env.AURAD_CHALLENGE;
      const headers = keepAliveHeaders(web3, coldWallet, account, timestamp, json, challenge);

      const response = await request({
        url: `${config.staking.host}/keepalive`,
        method: 'POST',
        headers,
        json,
        simple: false,
        resolveWithFullResponse: true,
      });

      const message = (response.body ? response.body.message : '');
      
      if (response.statusCode === 200) {
        console.log(`STAKING ONLINE: ${message}`);
        hasBeenOnline = true;
      } else {
        console.log(`STAKING OFFLINE: ${message}`);
      }
      worker.writeStatus({
        keepAlive: {
          status: response.statusCode,
          timestamp: Date.now(),
          message
        }
      });
    } else {
      console.log(`STAKING OFFLINE: no wallet configured`);
      hasBeenOnline = true;
    }
  } catch (e) {
    console.log(`STAKING OFFLINE`);
    Sentry.captureException(e);
    console.log(e);
  } finally {
    if (hasBeenOnline) {
      if (worker.currentBlock === previousWorkerBlock) {
        timeSinceLastBlockUpdate = Date.now() - previousWorkerBlockTime;
      } else {
        previousWorkerBlock = worker.currentBlock;
        previousWorkerBlockTime = Date.now();
      }
      if (timeSinceLastBlockUpdate > MAX_OFFLINE_TIME) {
        await fs.appendFile('downtime.log', `Downtime detected at ${Date.now()}, last block was processed at ${previousWorkerBlockTime}\n`);
      }
    }
  }
};

const loadWallet = async () => {
  try {
    const settings = JSON.parse(await fs.readFile('ipc/settings.json'));
    coldWallet = settings.coldWallet; // eslint-disable-line
    const hotWalletEncrypted = settings.hotWallet;
    account = await web3.eth.accounts.decrypt(hotWalletEncrypted, settings.token);
    process.env.PASSPHRASE = '';
  } catch (e) {
    console.log('error loading settings.json, wrong passphrase?');
  }
};


const runner = async () => {
  let firstBlock = IDEX_FIRST_BLOCK;
  if (process.env.FORCE_SYNC !== '1') {
    const lastTrade = await db.sequelize.models.Trade.findOne({ order: [['blockNumber', 'DESC']] });
    firstBlock = lastTrade ? lastTrade.get('blockNumber') - 1 : IDEX_FIRST_BLOCK;
  }
  worker = await Worker.build(firstBlock);
  worker.getTransactions();

  return worker;
};

const api = async () => new Promise((resolve) => {
  server.listen(config.server.port, () => {
    console.log(`API listening on port ${config.server.port}`);
    resolve();
  });
});

const statusApi = () => new Promise(resolve => {
  const port = config.server.statusApiPort;
  if (!port) {
    resolve();
    return;
  }
  const _api = express();
  _api.get('/status', (req, response) => {
    response.json({ lastScannedBlock: worker ? worker.currentBlock : 0 });
  });
  http.createServer(_api).listen(port, () => {
    console.log(`Status API listening on port ${port}`);
    resolve();
  });
});

let keepAliveInterval;

const startKeepAlive = () => {
  keepalive()
  keepAliveInterval = setInterval(keepalive, 30000);
};

(async () => {
  if (!await db.waitFor(10)) {
    console.log('Could not establish db connection, exiting');
    return;
  }
  if (process.env.AUTO_MIGRATE === '1') {
    try {
      await migrate();
    } catch(e) {
      console.log('DB migration failed, exiting');
      process.exit(1);
    }
  }
  await loadWallet();
  await waitForRpc();
  await buildServer();
  await api();
  await statusApi();

  const runningWorker = await runner();
  runningWorker.on('ready', () => {
    startKeepAlive();
  });
})();

const shutdown = async (cb) => {
  db._closed = true;
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  return new Promise.mapSeries([
    server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve(),
    db.sequelize.close(),
    worker.close(),
    fs.unlink('ipc/status.json')
  ]);
}

process.on('SIGINT', async () => {
  process.on('uncaughtException', () => {
    console.log('uncaughtException while shutting down');
  });
  console.log('SIGINT signal received.');
  try {
    await shutdown();
  } finally {
    process.exit(1);
  }
});

module.exports = {
  server,
  app,
  web3,
  db,
  routes,
};
