// blobLogger.js

require('dotenv').config();

const { BlobServiceClient } = require('@azure/storage-blob');

const connectionString = process.env.AZURE_BLOB_LOG_CONNECTION_STRING;
const containerName = process.env.AZURE_BLOB_LOG_CONTAINER;
const PREFIX = 'aspire-log';
const FLUSH_INTERVAL_MS = 10000;

// Only create the blob client if config is present.
// Without this guard, a missing env var crashes the whole module on load
// ("Cannot read properties of undefined (reading 'startsWith')").
let containerClient = null;

if (connectionString && containerName) {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);
  } catch (err) {
    console.error('Blob logging disabled: failed to init client:', err.message);
  }
} else {
  console.warn(
    'Blob logging disabled: AZURE_BLOB_LOG_CONNECTION_STRING and/or AZURE_BLOB_LOG_CONTAINER not set'
  );
}

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
  console.log(line); // always mirror to console (shows in Azure log stream too)

  // Only buffer if blob logging is active, so memory doesn't grow unbounded
  if (containerClient) buffer.push(line);
}

async function flush() {
  if (!containerClient || buffer.length === 0 || flushing) return;
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

const intervalHandle = containerClient ? setInterval(flush, FLUSH_INTERVAL_MS) : null;

// make sure buffered lines aren't lost if the app shuts down
async function shutdown() {
  if (intervalHandle) clearInterval(intervalHandle);
  await flush();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { log, flush };