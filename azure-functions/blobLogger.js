// blobLogger.js

require('dotenv').config();


const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.AZURE_BLOB_LOG_CONNECTION_STRING;
const containerName = process.env.AZURE_BLOB_LOG_CONTAINER;
const PREFIX = 'aspire-log';
const FLUSH_INTERVAL_MS = 10000;

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
const containerClient = blobServiceClient.getContainerClient(containerName);

let buffer = [];
let flushing = false;

function pad(n) { return String(n).padStart(2, '0'); }

function getCurrentBlobPath() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  return {
    folder: `${yyyy}-${mm}-${dd}`,
    blobName: `${yyyy}-${mm}-${dd}/${PREFIX}-${yyyy}${mm}${dd}-${hh}.log`
  };
}

function log(level, moduleName, funcName, message) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} || ${level} || ${moduleName} || ${funcName} || ${message}`;
  buffer.push(line);
  // still mirror to console so local `npm run dev` behavior is unchanged
  console.log(line);
}

async function flush() {
  if (buffer.length === 0 || flushing) return;
  flushing = true;
  const linesToWrite = buffer.splice(0, buffer.length);
  const content = linesToWrite.join('\n') + '\n';

  try {
    const { blobName } = getCurrentBlobPath();
    const appendBlobClient = containerClient.getAppendBlobClient(blobName);
    const exists = await appendBlobClient.exists();
    if (!exists) await appendBlobClient.create();
    await appendBlobClient.appendBlock(content, Buffer.byteLength(content));
  } catch (err) {
    console.error('Blob flush failed, requeueing lines:', err.message);
    buffer.unshift(...linesToWrite); // put them back, retry next interval
  } finally {
    flushing = false;
  }
}

const intervalHandle = setInterval(flush, FLUSH_INTERVAL_MS);

// make sure buffered lines aren't lost if the app shuts down
async function shutdown() {
  clearInterval(intervalHandle);
  await flush();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { log, flush };