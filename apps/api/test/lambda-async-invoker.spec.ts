import { describe, expect, it } from 'vitest';
import { LambdaAsyncInvoker, type LambdaInvokeClient } from '../src/runtime/lambda-async-invoker';

function recordingLambda(statusCode: number) {
  const sent: { command: string; input: Record<string, unknown> }[] = [];
  const client: LambdaInvokeClient = {
    send: (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ command: command.constructor.name, input: command.input });
      return { StatusCode: statusCode };
    }) as LambdaInvokeClient['send'],
  };
  return { client, sent };
}

describe('S3 Delivery: the AsyncInvoker port on Lambda (architecture §5.4)', () => {
  // Value: protects=the API and the jobs tick start the notifier without waiting for it, with the event as JSON; fails_when=InvocationType is RequestResponse (the request waits for every email) or the function name or payload is wrong; why_new=first cloud invoker; seam=recording client; no_claim=IAM permission to invoke (infra, WP0.9)
  it('invokes the target function with InvocationType Event and the JSON event', async () => {
    const { client, sent } = recordingLambda(202);
    const invoker = new LambdaAsyncInvoker(client, { notifier: 'fisio-dev-notifier' });
    await invoker.invoke('notifier', { kind: 'deliver-due', tenantId: 'main' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      command: 'InvokeCommand',
      input: { FunctionName: 'fisio-dev-notifier', InvocationType: 'Event' },
    });
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.input.Payload as Uint8Array))).toEqual({
      kind: 'deliver-due',
      tenantId: 'main',
    });
  });

  // Value: protects=an event Lambda did not queue is reported, so the caller logs it and the tick catches up; fails_when=any status is taken as queued; why_new=first cloud invoker; seam=recording client; no_claim=none
  it('throws when Lambda does not answer 202 Accepted', async () => {
    const { client, sent } = recordingLambda(200);
    const invoker = new LambdaAsyncInvoker(client, { notifier: 'n' });
    await expect(invoker.invoke('notifier', {})).rejects.toBeInstanceOf(Error);
    expect(sent).toHaveLength(1);
  });
});
