'use strict';
// tests for apps-list
// Generated by serverless-mocha-plugin

const mod = require('../../apps/list/handler.js');
const mochaPlugin = require('serverless-mocha-plugin');
const lambdaWrapper = mochaPlugin.lambdaWrapper;
const expect = mochaPlugin.chai.expect;

var wrapped;

describe('apps-list', function() {
  before(function(done) {
    wrapped = lambdaWrapper.wrap(mod);

    done();
  });
  
  it('implement tests here', function(done) {
    var event = {};
    wrapped.runHandler(event, {}, function(err, res) {
      if (err) throw err;

      console.log(res);
      done('no tests implemented');
    });
  });
});
