'use strict';

require('babel-polyfill');
const _ = require('lodash');
const async = require('async');
const aws = require('aws-sdk');
const db = require('../lib/db');
const env = require('../env.yml');
const identity = require('../lib/identity');
const moment = require('moment');
const request = require('../lib/request');
const vandium = require('vandium');

module.exports.links = vandium.createInstance({
  validation: {
    schema: {
      headers: vandium.types.object().keys({
        Authorization: vandium.types.string().required()
          .error(Error('Authorization header is required')),
      }),
      pathParameters: vandium.types.object().keys({
        appId: vandium.types.string().required(),
      }),
    },
  },
}).handler((event, context, callback) => request.errorHandler(() => {
  db.connect({
    host: env.RDS_HOST,
    user: env.RDS_USER,
    password: env.RDS_PASSWORD,
    database: env.RDS_DATABASE,
    ssl: env.RDS_SSL,
    port: env.RDS_PORT,
  });
  async.waterfall([
    function (cb) {
      identity.getUser(env.REGION, event.headers.Authorization, cb);
    },
    function (user, cb) {
      db.checkAppAccess(event.pathParameters.appId, user.vendor, err => cb(err));
    },
    function (cb) {
      const s3 = new aws.S3();
      const validity = 3600;
      const expires = moment().add(validity, 's').utc().format();
      async.parallel({
        32: (cb2) => {
          s3.getSignedUrl(
            'putObject',
            {
              Bucket: env.S3_BUCKET,
              Key: `${event.pathParameters.appId}/32/latest.png`,
              Expires: validity,
              ContentType: 'image/png',
              ACL: 'public-read',
            },
            cb2
          );
        },
        64: (cb2) => {
          s3.getSignedUrl(
            'putObject',
            {
              Bucket: env.S3_BUCKET,
              Key: `${event.pathParameters.appId}/64/latest.png`,
              Expires: validity,
              ContentType: 'image/png',
              ACL: 'public-read',
            },
            cb2
          );
        },
      }, (err, data) => {
        const res = data;
        if (err) {
          return cb(err);
        }
        res.expires = expires;
        return cb(null, res);
      });
    },
  ], (err, res) => {
    db.end();
    return request.response(err, res, event, context, callback);
  });
}, context, callback));


module.exports.upload = vandium.createInstance()
.handler((event, context, callback) => request.errorHandler(() => {
  if (!_.has(event, 'Records') || !event.Records.length ||
    !_.has(event.Records[0], 's3') || !_.has(event.Records[0].s3, 'bucket') ||
    !_.has(event.Records[0].s3, 'object') ||
    !_.has(event.Records[0].s3.bucket, 'name') ||
    !_.has(event.Records[0].s3.object, 'key')) {
    throw Error(`Event is missing. See: ${JSON.stringify(event)}`);
  }

  if (event.Records[0].eventName !== 'ObjectCreated:Put') {
    return callback();
  }

  const bucket = event.Records[0].s3.bucket.name;
  const key = event.Records[0].s3.object.key;
  const appId = key.split('/').shift();
  const size = key.split('/')[1];

  db.connect({
    host: env.RDS_HOST,
    user: env.RDS_USER,
    password: env.RDS_PASSWORD,
    database: env.RDS_DATABASE,
    ssl: env.RDS_SSL,
    port: env.RDS_PORT,
  });
  const s3 = new aws.S3();
  async.waterfall([
    function (cb) {
      db.addAppIcon(appId, size, (err, version) => cb(null, version));
    },
    function (version, cb) {
      s3.copyObject(
        {
          CopySource: `${bucket}/${key}`,
          Bucket: bucket,
          Key: `${appId}/${size}/${version}.png`,
          ACL: 'public-read',
        },
        (err) => {
          cb(err);
        }
      );
    },
  ], (err, result) => {
    db.end();
    return callback(err, result);
  });
}, context, callback));
