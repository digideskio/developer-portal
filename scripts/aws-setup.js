'use strict';

const _ = require('lodash');
const async = require('async');
const exec = require('child_process').exec;
const yaml = require('yamljs');

const setup = module.exports;

setup.accountId = null;

setup.saveAccountId = function (cb) {
  exec('aws sts get-caller-identity --output text --query Account', (err, out) => {
    if (err) {
      return cb(`AWS get identity error: ${err}`);
    }
    setup.accountId = _.trim(out);
    console.info(`- Account id saved: ${setup.accountId}`);
    return cb(null, setup.accountId);
  });
};

setup.registerEmail = function (region, email, cb) {
  exec(`aws ses verify-email-identity --region ${region} --email-address ${email}`, (err) => {
    if (err) {
      return cb(`SES registration error: ${err}`);
    }
    console.info(`- Email registered in SES: ${email}`);
    return cb();
  });
};

setup.createCognitoPool = function (region, name, email, cb) {
  async.waterfall([
    (cb2) => {
      const emailArn = `arn:aws:ses:${region}:${setup.accountId}:identity/${email}`;
      exec(`aws cognito-idp create-user-pool --region ${region} --pool-name ${name} \
        --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":false}}' \
        --email-configuration SourceArn=${emailArn} --auto-verified-attributes email`, (err, out) => {
        if (err) {
          cb2(`Cognito Create Pool error: ${err}`);
        }
        const poolId = JSON.parse(out).UserPool.Id;
        console.info(`- Cognito User Pool created: ${poolId}`);
        cb2(null, poolId);
      });
    },
    (poolId, cb2) => {
      exec(`aws cognito-idp add-custom-attributes --region ${region} --user-pool-id ${poolId} \
        --custom-attributes '[{"Name":"isAdmin","AttributeDataType":"Number","DeveloperOnlyAttribute":false,"Mutable":true,"Required": false,"NumberAttributeConstraints":{"MinValue":"0","MaxValue":"1"}}]'`, (err) => {
        if (err) {
          cb2(`Cognito Create Pool error: ${err}`);
        }
        console.info('- Attributes to Cognito User Pool added');
        cb2(null, poolId);
      });
    },
    (poolId, cb2) => {
      exec(`aws cognito-idp create-user-pool-client --region ${region} --user-pool-id ${poolId} --client-name ${name} \
        --no-generate-secret --read-attributes profile email name "custom:isAdmin" --write-attributes profile email name "custom:isAdmin" \
        --explicit-auth-flows ADMIN_NO_SRP_AUTH`, (err, out) => {
        if (err) {
          cb2(`Cognito Create Pool error: ${err}`);
        }
        const clientId = JSON.parse(out).UserPoolClient.ClientId;
        console.info('- Cognito User Pool Client created');
        cb2(null, { poolId, clientId });
      });
    },
  ], cb);
};

setup.updateCognitoPool = function (region, poolId, name, stage, cb) {
  const messageHandlerArn = `arn:aws:lambda:${region}:${setup.accountId}:function:${name}-${stage}-authEmailTrigger`;
  exec(`aws cognito-idp update-user-pool --region ${region} --user-pool-id ${poolId} \
        --lambda-config '{"CustomMessage": "${messageHandlerArn}"}'`, (err) => {
    if (err) {
      cb(`Cognito Update Pool error: ${err}`);
    }
    console.info(`- Cognito User Pool updated: ${poolId}`);
    cb();
  });
};

setup.subscribeLogs = function (region, service, stage, cb) {
  async.each(_.keys(yaml.load(`${__dirname}/../serverless.yml`).functions), (item, cb2) => {
    if (item !== 'logger') {
      async.waterfall([
        (cb3) => {
          exec(`serverless invoke -f ${item}`, (err) => {
            if (err) {
              console.warn(`Serverless invoke ${item} error: ${err}`);
            }
            cb3();
          });
        },
        (cb3) => {
          exec(`aws lambda add-permission --region ${region} \
            --function-name ${service}-${stage}-logger \
            --statement-id ${service}-${stage}-${item} \
            --action lambda:InvokeFunction \
            --principal logs.${region}.amazonaws.com`, (err) => {
            if (err && !_.includes(err.message, 'ResourceConflictException')) {
              console.warn(`Add function ${item} permission error: ${err}`);
            }
            cb3();
          });
        },
        (cb3) => {
          exec(`aws logs put-subscription-filter --region ${region} \
            --filter-pattern '' \
            --filter-name LambdaToPapertrail-${service}-${stage} \
            --log-group-name /aws/lambda/${service}-${stage}-${item} \
            --destination-arn arn:aws:lambda:${region}:${setup.accountId}:function:${service}-${stage}-logger`, (err) => {
            if (err) {
              console.warn(`Put subscription filter ${item} error: ${err}`);
            }
            cb3(err);
          });
        },
      ], cb2);
    } else {
      cb2();
    }
  }, (err) => {
    if (err) {
      cb(err);
    }
    console.info('- Logs subscribed');
    cb();
  });
};

setup.deleteCognitoPool = function (region, id, cb) {
  exec(`aws cognito-idp delete-user-pool --region ${region} --user-pool-id ${id}`, (err) => {
    if (err) {
      cb(`Remove Cognito pool error: ${err}`);
    }

    console.info(`- Cognito Pool ${id} removed`);
    cb();
  });
};

setup.getCloudFormationOutput = function (region, name, stage, cb) {
  exec(`aws cloudformation describe-stacks --region ${region} --stack-name ${name}-${stage}`, (err, out) => {
    if (err) {
      cb(`Describe CloudFormation stack error: ${err}`);
    }
    const res = JSON.parse(out);

    if (!_.has(res, 'Stacks') || res.Stacks.length < 1) {
      cb(`Describe CloudFormation stack error: ${JSON.stringify(res)}`);
    }

    const result = {};
    _.each(res.Stacks[0].Outputs, (item) => {
      if (_.includes(['RdsUri', 'RdsPort', 'CloudFrontUri', 'ServiceEndpoint'], item.OutputKey)) {
        result[item.OutputKey] = item.OutputValue;
      }
    });
    console.info('- CloudFormation stack described');
    cb(null, result);
  });
};

setup.s3Upload = function (folder, bucket, cb) {
  exec(`aws s3 sync ${folder} s3://${bucket} --acl public-read`, (err) => {
    if (err) {
      return cb(`S3 upload error: ${err}`);
    }
    return cb();
  });
};

setup.deleteLogs = function (region, service, stage, cb) {
  async.each(_.keys(yaml.load(`${__dirname}/../serverless.yml`).functions), (item, cb2) => {
    exec(`aws logs delete-log-group --region ${region} \
      --log-group-name /aws/lambda/${service}-${stage}-${item}`, (err) => {
      if (err) {
        console.warn(`Delete log ${item} error: ${err}`);
      }
      cb2();
    });
  }, (err) => {
    if (err) {
      cb(err);
    }
    console.info('- Logs deleted');
    cb();
  });
};
