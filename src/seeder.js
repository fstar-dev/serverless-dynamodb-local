const AWS = require("aws-sdk");
const BbPromise = require("bluebird");
const _ = require("lodash");
const path = require("path");
const fs = require("fs");

// DynamoDB has a 25 item limit in batch requests
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html
const MAX_MIGRATION_CHUNK = 25;

// TODO: let this be configurable
const MIGRATION_SEED_CONCURRENCY = 5;

/**
 * Writes a batch chunk of migration seeds to DynamoDB. DynamoDB has a limit on the number of
 * items that may be written in a batch operation.
 * @param {DynamoDocumentClient} dynamodb The DynamoDB Document client
 * @param {string} tableName The table name being written to
 * @param {any[]} seeds The migration seeds being written to the table
 */
function writeSeedBatch(dynamodb, tableName, seeds) {
  const params = {
    RequestItems: {
      [tableName]: seeds.map((seed) => ({
        PutRequest: {
          Item: seed,
        },
      })),
    },
  };
  return new BbPromise((resolve, reject) => {
    // interval lets us know how much time we have burnt so far. This lets us have a backoff mechanism to try
    // again a few times in case the Database resources are in the middle of provisioning.
    let interval = 0;
    function execute(interval) {
      setTimeout(() => dynamodb.batchWrite(params, (err) => {
        if (err) {
          if (err.code === "ResourceNotFoundException" && interval <= 5000) {
            execute(interval + 1000);
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      }), interval);
    }
    execute(interval);
  });
}

/**
 * Writes a seed corpus to the given database table
 * @param {DocumentClient} dynamodb The DynamoDB document instance
 * @param {string} tableName The table name
 * @param {any[]} seeds The seed values
 */
function writeSeeds(dynamodb, tableName, seeds) {
  if (!dynamodb) {
    throw new Error("dynamodb argument must be provided");
  }
  if (!tableName) {
    throw new Error("table name argument must be provided");
  }
  if (!seeds) {
    throw new Error("seeds argument must be provided");
  }

  if (seeds.length > 0) {
    const seedChunks = _.chunk(seeds, MAX_MIGRATION_CHUNK);
    return BbPromise.map(
      seedChunks,
      (chunk) => writeSeedBatch(dynamodb, tableName, chunk),
      { concurrency: MIGRATION_SEED_CONCURRENCY }
    )
      .then(() => console.log("Seed running complete for table: " + tableName));
  }
}

/**
 * A promise-based function that determines if a file exists
 * @param {string} fileName The path to the file
 */
function fileExists(fileName) {
  return new BbPromise((resolve) => {
    fs.exists(fileName, (exists) => resolve(exists));
  });
}

/**
 * Scrapes seed files out of a given location. This file may contain
 * either a simple json object, or an array of simple json objects. An array
 * of json objects is returned.
 *
 * @param {any} location the filename to read seeds from.
 */
function getSeedsAtLocation(location) {
  // load the file as JSON
  const result = require(location);

  // Ensure the output is an array
  if (Array.isArray(result)) {
    return result;
  } else {
    return [ result ];
  }
}

/**
 * Locates seeds given a set of files to scrape
 * @param {string[]} sources The filenames to scrape for seeds
 */
function locateSeeds(sources = [], cwd = process.cwd()) {
  const locations = sources.map(source => path.join(cwd, source));
  return BbPromise.map(locations, (location) => {
    return fileExists(location).then((exists) => {
      if(!exists) {
        throw new Error("source file " + location + " does not exist");
      }
      return getSeedsAtLocation(location);
    });
  // Smash the arrays together
  }).then((seedArrays) => [].concat.apply([], seedArrays));
}

module.exports = { writeSeeds, locateSeeds };
