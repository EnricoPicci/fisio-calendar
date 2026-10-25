import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadCloudApiConfig,
  loadConfig,
  loadJobsConfig,
  loadNotifierConfig,
} from '../src/config';
import { LOCAL_DEFAULTS } from '../src/runtime/local';

const valid = {
  STAGE: 'dev',
  TABLE_NAME: 'fisio-dev',
  AUTH_ISSUER: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_example/',
  AUTH_CLIENT_ID: 'abc',
  WEB_ORIGIN: 'https://fisio.example/ignored/path',
};

describe('Config port (architecture §4.1, §11.4)', () => {
  // Value: protects=the API reads its issuer, client and table from the environment, and derives Cognito's JWKS URI; fails_when=a variable is renamed or the JWKS default drifts from the issuer's well-known path; why_new=first Config; seam=none; no_claim=the CDK environment (WP0.9)
  it('reads the environment and derives the JWKS URI from the issuer', () => {
    expect(loadConfig(valid)).toEqual({
      stage: 'dev',
      tableName: 'fisio-dev',
      auth: {
        issuer: valid.AUTH_ISSUER,
        jwksUri:
          'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_example/.well-known/jwks.json',
        clientId: 'abc',
      },
      webOrigin: 'https://fisio.example',
    });
  });

  // Value: protects=a misconfigured function fails at cold start naming the variables, without echoing values; fails_when=missing or blank variables pass silently or the message prints values; why_new=first Config; seam=none; no_claim=CloudWatch output
  it('refuses missing, blank or malformed variables and names them, not their values', () => {
    const attempt = () =>
      loadConfig({
        ...valid,
        TABLE_NAME: ' ',
        AUTH_ISSUER: 'not a url',
        STAGE: 'staging',
        AUTH_CLIENT_ID: undefined,
      });
    expect(attempt).toThrow(ConfigError);
    for (const name of ['STAGE', 'TABLE_NAME', 'AUTH_ISSUER', 'AUTH_CLIENT_ID']) {
      expect(attempt, name).toThrow(name);
    }
    expect(attempt).not.toThrow(/not a url|staging/);
  });

  // Value: protects=each Lambda reads what it needs and fails at cold start naming what is missing: the api its Cognito pool and notifier function, the notifier its SES sender, the jobs function its notifier and the tenant (default `main`); fails_when=a variable is renamed, an optional one becomes required, or the jobs tenant default changes; why_new=WP0.6 adds the notifier and jobs functions; seam=none; no_claim=the values the CDK App stack sets (WP0.9)
  it('the api, notifier and jobs functions each read their own variables', () => {
    expect(() => loadCloudApiConfig(valid)).toThrow('USER_POOL_ID, NOTIFIER_FUNCTION_NAME');
    expect(
      loadCloudApiConfig({ ...valid, USER_POOL_ID: 'eu-central-1_x', NOTIFIER_FUNCTION_NAME: 'n' }),
    ).toMatchObject({ userPoolId: 'eu-central-1_x', notifierFunctionName: 'n' });

    const table = { STAGE: 'dev', TABLE_NAME: 'fisio-dev' };
    expect(() => loadNotifierConfig(table)).toThrow('EMAIL_FROM_ADDRESS');
    expect(loadNotifierConfig({ ...table, EMAIL_FROM_ADDRESS: 'noreply@fisio.example' })).toEqual({
      stage: 'dev',
      tableName: 'fisio-dev',
      email: { from: { name: 'Fisio Calendar', address: 'noreply@fisio.example' } },
    });
    expect(
      loadNotifierConfig({
        ...table,
        EMAIL_FROM_ADDRESS: 'noreply@fisio.example',
        EMAIL_FROM_NAME: 'Studio Anna',
        SES_CONFIGURATION_SET: 'fisio-dev',
      }).email,
    ).toEqual({
      from: { name: 'Studio Anna', address: 'noreply@fisio.example' },
      configurationSet: 'fisio-dev',
    });

    expect(() => loadJobsConfig(table)).toThrow('NOTIFIER_FUNCTION_NAME');
    expect(
      loadJobsConfig({ ...table, NOTIFIER_FUNCTION_NAME: 'n', TENANT_ID: 'main' }),
    ).toMatchObject({ tenantId: 'main', notifierFunctionName: 'n' });
    expect(() =>
      loadJobsConfig({ ...table, NOTIFIER_FUNCTION_NAME: 'n', TENANT_ID: 'T#1' }),
    ).toThrow('TENANT_ID');
  });

  // Value: protects=in the cloud the invitation links are https and the jobs tick names its tenant, so neither falls back to a value that only suits the laptop; fails_when=an http origin reaches dev or prod invitations, or a jobs function without TENANT_ID silently ticks the default tenant's (possibly empty) partitions; why_new=WP0.6 review; seam=none; no_claim=the values the CDK App stack sets (WP0.9)
  it('outside local and test, WEB_ORIGIN must be https and the jobs tenant explicit', () => {
    expect(() => loadConfig({ ...valid, WEB_ORIGIN: 'http://fisio.example' })).toThrow(
      'WEB_ORIGIN',
    );
    expect(
      loadConfig({ ...valid, STAGE: 'local', WEB_ORIGIN: 'http://127.0.0.1:5173' }).webOrigin,
    ).toBe('http://127.0.0.1:5173');

    const jobs = { TABLE_NAME: 'fisio-x', NOTIFIER_FUNCTION_NAME: 'n' };
    for (const STAGE of ['dev', 'prod']) {
      expect(() => loadJobsConfig({ ...jobs, STAGE }), STAGE).toThrow('TENANT_ID');
    }
    for (const STAGE of ['local', 'test']) {
      expect(loadJobsConfig({ ...jobs, STAGE }).tenantId, STAGE).toBe('main');
    }
  });

  // Value: protects=the local runtime targets DynamoDB Local and the fisio-local table by default; fails_when=a default changes, e.g. to localhost (IPv6 first) or a cloud table; why_new=first local root; seam=none; no_claim=the emulator's port (WP0.5)
  it('local defaults point at DynamoDB Local on 127.0.0.1 and the fisio-local table', () => {
    const config = loadConfig(LOCAL_DEFAULTS);
    expect(config).toMatchObject({
      stage: 'local',
      tableName: 'fisio-local',
      dynamoEndpoint: 'http://127.0.0.1:8000',
      webOrigin: 'http://127.0.0.1:5173',
    });
  });
});
