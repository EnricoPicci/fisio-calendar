import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { LOCAL_DEFAULTS } from '../src/runtime/local';

const valid = {
  STAGE: 'dev',
  TABLE_NAME: 'fisio-dev',
  AUTH_ISSUER: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_example/',
  AUTH_CLIENT_ID: 'abc',
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
    expect(attempt).toThrow(/STAGE, TABLE_NAME, AUTH_ISSUER, AUTH_CLIENT_ID|TABLE_NAME/);
    expect(attempt).not.toThrow(/not a url|staging/);
  });

  // Value: protects=the local runtime targets DynamoDB Local and the fisio-local table by default; fails_when=a default changes, e.g. to localhost (IPv6 first) or a cloud table; why_new=first local root; seam=none; no_claim=the emulator's port (WP0.5)
  it('local defaults point at DynamoDB Local on 127.0.0.1 and the fisio-local table', () => {
    const config = loadConfig(LOCAL_DEFAULTS);
    expect(config).toMatchObject({
      stage: 'local',
      tableName: 'fisio-local',
      dynamoEndpoint: 'http://127.0.0.1:8000',
    });
  });
});
