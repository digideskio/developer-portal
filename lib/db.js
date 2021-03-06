'use strict';

const _ = require('lodash');
const mysql = require('mysql');
const Promise = require('bluebird');
const error = require('./error');

Promise.promisifyAll(mysql);
Promise.promisifyAll(require('mysql/lib/Connection').prototype);

let db;

const Db = module.exports;

const defaultLimit = 1000;

Db.connect = (env) => {
  db = mysql.createConnection({
    host: env.RDS_HOST,
    user: env.RDS_USER,
    password: env.RDS_PASSWORD,
    database: env.RDS_DATABASE,
    ssl: env.RDS_SSL,
    port: env.RDS_PORT,
    // debug: ['ComQueryPacket'],
  });
  return db.connectAsync();
};

Db.checkAppNotExists = id =>
  db.queryAsync('SELECT COUNT(*) as c FROM apps WHERE id = ?', [id])
  .spread((res) => {
    if (res.c !== 0) {
      throw error.badRequest('Already exists');
    }
  });

Db.checkAppAccess = (id, vendor) =>
  db.queryAsync(
    'SELECT COUNT(*) as c FROM apps WHERE id = ? AND vendor = ?',
    [id, vendor]
  )
  .spread((res) => {
    if (res.c === 0) {
      throw error.notFound();
    }
  });

Db.insertApp = (paramsIn) => {
  const params = Db.formatAppInput(paramsIn);
  let promise = db.queryAsync('INSERT INTO apps SET ?', params)
  .then(() => {
    delete params.vendor;
    return db.queryAsync('INSERT INTO appVersions SET ?', params);
  });
  if (_.has(paramsIn, 'projects')) {
    promise = promise
    .then(() => Db.assignProjects(paramsIn.id, paramsIn.projects));
  }
  return promise;
};

Db.assignProjects = (id, projects = []) => {
  const arg = _.map(projects, p => [id, p]);
  return db.beginTransactionAsync()
  .then(() => db.queryAsync('DELETE FROM appsProjects WHERE app=?', [id]))
  .then(() => db.queryAsync('INSERT INTO appsProjects (app, project) VALUES ?', [arg]))
  .then(() => db.commitAsync());
};

Db.copyAppToVersion = (id, user) =>
  db.queryAsync('SELECT * FROM apps WHERE id = ?', [id])
  .spread((res) => {
    const result = res;
    if (result.length === 0) {
      throw error.notFound(`App ${id} does not exist`);
    } else {
      delete result.vendor;
      delete result.isApproved;
      delete result.createdOn;
      delete result.createdBy;
      return result;
    }
  })
  .then((appIn) => {
    const app = appIn;
    app.createdBy = user;
    return db.queryAsync('INSERT INTO appVersions SET ?', app);
  });

Db.updateApp = (paramsIn, id, user) => {
  const params = Db.formatAppInput(paramsIn);
  let promise;
  if (_.size(params)) {
    promise = db.queryAsync(
      'UPDATE apps SET ?, version = version + 1 WHERE id = ?',
      [params, id]
    )
    .then(() => Db.copyAppToVersion(id, user));
  }
  if (_.has(paramsIn, 'projects')) {
    const assignPromise = Db.assignProjects(id, paramsIn.projects);
    if (promise) {
      promise = promise.then(() => assignPromise);
    } else {
      promise = assignPromise;
    }
  }
  return promise;
};

Db.getApp = (id, version = null) => {
  let query;
  let params;
  if (version) {
    query = 'SELECT * FROM appVersions WHERE id = ? AND version = ?';
    params = [id, version];
  } else {
    query = 'SELECT * FROM apps WHERE id = ?';
    params = [id];
  }

  return db.queryAsync(query, params)
  .spread((res) => {
    if (!res) {
      throw error.notFound();
    }
    return Db.formatAppOutput(res);
  });
};

Db.listAppsForVendor = (vendor, offset = 0, limit = defaultLimit) =>
  db.queryAsync(
    'SELECT id, version, name, type, createdOn, createdBy, isApproved, ' +
    'legacyUri ' +
    'FROM apps ' +
    'WHERE vendor = ?' +
    'ORDER BY name LIMIT ? OFFSET ?;',
    [vendor, limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)]
  )
  .then((res) => {
    res.map((appIn) => {
      const app = appIn;
      app.isApproved = app.isApproved === 1;
      return app;
    });
    return res;
  });

Db.listVersions = (id, offset = 0, limit = defaultLimit) =>
  db.queryAsync(
    'SELECT * ' +
    'FROM appVersions ' +
    'WHERE id = ? ' +
    'ORDER BY createdOn LIMIT ? OFFSET ?;',
    [id, limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)]
  )
  .then((res) => {
    res.map(Db.formatAppOutput);
    return res;
  });


Db.getVendor = id =>
  db.queryAsync('SELECT id, name, address, email FROM vendors WHERE id = ?', [id])
  .spread((res) => {
    if (!res) {
      throw error.notFound();
    }
    return res;
  });

Db.listVendors = (offset = 0, limit = defaultLimit) =>
  db.queryAsync(
    'SELECT id, name, address, email ' +
    'FROM vendors ' +
    'ORDER BY id LIMIT ? OFFSET ?;',
    [limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)]
  );

Db.listApps = (filter, offset = 0, limit = defaultLimit) => {
  let filterSql = '';
  if (filter === 'unapproved') {
    filterSql = 'WHERE isApproved=0 ';
  }

  return db.queryAsync(
    `SELECT id, version, name, type, createdOn, createdBy, isApproved, legacyUri
    FROM apps ${filterSql}
    ORDER BY name LIMIT ? OFFSET ?;`,
    [limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)]
  )
  .then(res => res.map((appIn) => {
    const app = appIn;
    app.isApproved = app.isApproved === 1;
    return app;
  }));
};

Db.getAppWithVendor = function (id, version, checkPublished = false) {
  let sql;
  let params;
  if (version) {
    sql = 'SELECT a.id, a.name, ap.vendor as vendorId, v.name as vendorName, ' +
      'v.address as vendorAddress, v.email as vendorEmail, a.version, ' +
      'a.type, a.repoType, a.repoOptions, a.repoUri, a.repoTag, ' +
      'a.shortDescription, a.longDescription, a.licenseUrl, ' +
      'a.documentationUrl, a.requiredMemory, a.processTimeout, a.encryption, ' +
      'a.defaultBucket, a.defaultBucketStage, a.forwardToken, a.forwardTokenDetails, ' +
      'a.cpuShares, a.uiOptions, ' +
      'a.imageParameters, a.testConfiguration, a.configurationSchema, ' +
      'a.emptyConfiguration, a.configurationDescription, a.actions, a.fees, ' +
      'a.limits, a.logger, a.loggerConfiguration, a.stagingStorageInput, a.icon32, ' +
      'a.icon64, a.legacyUri, a.isPublic, ap.isApproved ' +
      'FROM appVersions AS a ' +
      'LEFT JOIN apps ap ON (ap.id = a.id) ' +
      'LEFT JOIN vendors v ON (ap.vendor = v.id) ' +
      'WHERE a.id=? AND a.version=?';
    if (checkPublished) {
      sql += ' AND ap.isApproved=1 AND a.isPublic=1;';
    }
    params = [id, version];
  } else {
    sql = 'SELECT a.id, a.name, a.vendor as vendorId, v.name as vendorName, ' +
      'v.address as vendorAddress, v.email as vendorEmail, a.version, a.type, ' +
      'a.repoType, a.repoOptions, a.repoUri, a.repoTag, a.shortDescription, ' +
      'a.longDescription, a.licenseUrl, a.documentationUrl, a.requiredMemory, ' +
      'a.processTimeout,a.encryption, a.defaultBucket, a.defaultBucketStage, ' +
      'a.forwardToken, a.forwardTokenDetails, a.cpuShares, a.uiOptions, ' +
      'a.imageParameters, a.testConfiguration, ' +
      'a.configurationSchema, a.configurationDescription, a.emptyConfiguration, ' +
      'a.actions, a.fees, a.limits, a.logger, a.loggerConfiguration, ' +
      'a.stagingStorageInput, a.icon32, a.icon64, a.legacyUri, a.isPublic, ' +
      'a.isApproved ' +
      'FROM apps AS a ' +
      'LEFT JOIN vendors v ON (a.vendor = v.id) ' +
      'WHERE a.id=?';
    if (checkPublished) {
      sql += ' AND a.isApproved=1 AND a.isPublic=1;';
    }
    params = [id];
  }

  return db.queryAsync(sql, params).spread((res) => {
    if (!res) {
      throw error.notFound();
    }
    return Db.formatAppOutput(res);
  });
};

Db.listPublishedApps = (offset = 0, limit = defaultLimit) => {
  const sql = 'SELECT id, vendor, name, version, type, ' +
  'shortDescription, icon32, icon64, legacyUri ' +
  'FROM apps ' +
  'WHERE isApproved=1 AND isPublic=1 ';
  const args = [limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)];
  return db.queryAsync(sql, args)
  .then(res => res.map(Db.formatAppOutput));
};

Db.listPublishedAppVersions = (id, offset = 0, limit = defaultLimit) =>
  db.queryAsync(
    'SELECT a.id, a.name, ap.vendor as vendorId, v.name as vendorName, ' +
    'v.address as vendorAddress, v.email as vendorEmail, a.version, a.type, ' +
    'a.repoType, a.repoOptions, a.repoUri, a.repoTag, a.shortDescription, ' +
    'a.longDescription, a.licenseUrl, a.documentationUrl, a.requiredMemory, ' +
    'a.processTimeout, a.encryption, a.defaultBucket, a.defaultBucketStage, ' +
    'a.forwardToken, a.forwardTokenDetails, a.cpuShares, a.uiOptions, ' +
    'a.imageParameters, a.testConfiguration, ' +
    'a.configurationSchema, a.configurationDescription, a.emptyConfiguration, ' +
    'a.actions, a.fees, a.limits, a.logger, a.loggerConfiguration, ' +
    'a.stagingStorageInput, a.icon32, a.icon64, ap.legacyUri ' +
    'FROM appVersions a ' +
    'LEFT JOIN apps ap ON (ap.id = a.id) ' +
    'LEFT JOIN vendors v ON (ap.vendor = v.id) ' +
    'WHERE a.id=? AND ap.isApproved=1 AND a.isPublic=1 ' +
    'ORDER BY a.createdOn LIMIT ? OFFSET ?;',
    [id, limit ? _.toSafeInteger(limit) : defaultLimit, _.toSafeInteger(offset)]
  ).then(res => res.map(Db.formatAppOutput));


Db.addAppIcon = (id, size) =>
  db.queryAsync(
    'UPDATE apps ' +
    'SET ?? = CONCAT(?, version + 1, ?), version = version + 1 ' +
    'WHERE id = ?',
    [`icon${size}`, `${id}/${size}/`, '.png', id]
  )
  .then(() => Db.copyAppToVersion(id, 'upload'));

Db.getAppProjects = id =>
  db.queryAsync('SELECT project FROM appsProjects WHERE app=?', id);

Db.end = () => db.endAsync();

Db.endCallback = (err, res, callback) => {
  if (db) {
    // return db.endAsync(() => callback(err, res));
  }
  return callback(err, res);
};


Db.formatAppInput = (appIn) => {
  const app = _.clone(appIn);
  if (app.uiOptions) {
    app.uiOptions = JSON.stringify(app.uiOptions);
  }
  if (app.imageParameters) {
    app.imageParameters = JSON.stringify(app.imageParameters);
  }
  if (app.testConfiguration) {
    app.testConfiguration = JSON.stringify(app.testConfiguration);
  }
  if (app.configurationSchema) {
    app.configurationSchema = JSON.stringify(app.configurationSchema);
  }
  if (app.actions) {
    app.actions = JSON.stringify(app.actions);
  }
  if (app.emptyConfiguration) {
    app.emptyConfiguration = JSON.stringify(app.emptyConfiguration);
  }
  if (app.loggerConfiguration) {
    app.loggerConfiguration = JSON.stringify(app.loggerConfiguration);
  }

  if (_.has(app, 'repository.type')) {
    app.repoType = _.get(app, 'repository.type');
  }
  if (_.has(app, 'repository.uri')) {
    app.repoUri = _.get(app, 'repository.uri');
  }
  if (_.has(app, 'repository.tag')) {
    app.repoTag = _.get(app, 'repository.tag');
  }
  if (_.has(app, 'repository.options')) {
    app.repoOptions = app.repository.options
      ? JSON.stringify(app.repository.options) : null;
  }
  delete app.repository;

  const allowedKeys = ['id', 'vendor', 'isApproved', 'isPublic', 'createdOn',
    'createdBy', 'version', 'name', 'type', 'repoType', 'repoUri', 'repoTag',
    'repoOptions', 'shortDescription', 'longDescription', 'licenseUrl',
    'documentationUrl', 'requiredMemory', 'processTimeout', 'encryption',
    'defaultBucket', 'defaultBucketStage', 'forwardToken', 'forwardTokenDetails',
    'cpuShares', 'uiOptions', 'imageParameters', 'testConfiguration',
    'configurationSchema', 'configurationDescription', 'emptyConfiguration',
    'actions', 'fees', 'limits', 'logger', 'loggerConfiguration',
    'stagingStorageInput', 'icon32', 'icon64', 'legacyUri'];
  _.each(app, (val, key) => {
    if (!_.includes(allowedKeys, key)) {
      delete app[key];
    }
  });

  return app;
};

Db.formatAppOutput = (appIn) => {
  const app = appIn;
  app.uri = _.get(app, 'legacyUri', null) ?
    app.legacyUri : `docker/${app.id}`;
  delete app.legacyUri;

  if (_.has(app, 'encryption')) {
    app.encryption = app.encryption === 1;
  }
  if (_.has(app, 'isPublic')) {
    app.isPublic = app.isPublic === 1;
  }
  if (_.has(app, 'defaultBucket')) {
    app.defaultBucket = app.defaultBucket === 1;
  }
  if (_.has(app, 'forwardToken')) {
    app.forwardToken = app.forwardToken === 1;
  }
  if (_.has(app, 'forwardTokenDetails')) {
    app.forwardTokenDetails = app.forwardTokenDetails === 1;
  }
  if (_.has(app, 'uiOptions')) {
    app.uiOptions = typeof app.uiOptions === 'string'
      ? JSON.parse(app.uiOptions) : app.uiOptions;
    if (!app.uiOptions) {
      app.uiOptions = [];
    }
  }
  if (_.has(app, 'imageParameters')) {
    app.imageParameters = typeof app.imageParameters === 'string'
      ? JSON.parse(app.imageParameters) : app.imageParameters;
  }
  if (_.has(app, 'testConfiguration')) {
    app.testConfiguration = typeof app.testConfiguration === 'string'
      ? JSON.parse(app.testConfiguration) : app.testConfiguration;
  }
  if (_.has(app, 'configurationSchema')) {
    app.configurationSchema = typeof app.configurationSchema === 'string'
      ? JSON.parse(app.configurationSchema) : app.configurationSchema;
  }
  if (_.has(app, 'emptyConfiguration')) {
    app.emptyConfiguration = typeof app.emptyConfiguration === 'string'
      ? JSON.parse(app.emptyConfiguration) : app.emptyConfiguration;
  }
  if (_.has(app, 'loggerConfiguration')) {
    app.loggerConfiguration = typeof app.loggerConfiguration === 'string'
      ? JSON.parse(app.loggerConfiguration) : app.loggerConfiguration;
  }
  if (_.has(app, 'actions')) {
    app.actions = typeof app.actions === 'string'
      ? JSON.parse(app.actions) : app.actions;
    if (!app.actions) {
      app.actions = [];
    }
  }
  if (_.has(app, 'fees')) {
    app.fees = app.fees === 1;
  }
  if (_.has(app, 'isApproved')) {
    app.isApproved = app.isApproved === 1;
  }
  if (_.has(app, 'vendorId') && _.has(app, 'vendorName')
    && _.has(app, 'vendorAddress') && _.has(app, 'vendorEmail')) {
    app.vendor = {
      id: app.vendorId,
      name: app.vendorName,
      address: app.vendorAddress,
      email: app.vendorEmail,
    };
    delete app.vendorId;
    delete app.vendorName;
    delete app.vendorAddress;
    delete app.vendorEmail;
  }
  if (_.has(app, 'repoType')) {
    app.repository = {
      type: _.get(app, 'repoType'),
      uri: _.get(app, 'repoUri'),
      tag: _.get(app, 'repoTag'),
      options: app.repoOptions ? JSON.parse(app.repoOptions) : {},
    };
    delete app.repoType;
    delete app.repoUri;
    delete app.repoTag;
    delete app.repoOptions;
  }
  return app;
};
