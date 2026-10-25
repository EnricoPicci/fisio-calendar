import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { AsyncInvoker, AsyncTarget } from '@fisio/domain';

/**
 * The `AsyncInvoker` port in the cloud (docs/architecture.md §5.4): `Lambda.invoke` with
 * `InvocationType: Event`, which returns once Lambda has queued the event (HTTP 202). Lambda then
 * retries a failed run twice on its own; the notifier's conditional writes make that harmless.
 * The local and spec form is `InProcessAsyncInvoker` in `@fisio/domain`.
 */
export type LambdaInvokeClient = Pick<LambdaClient, 'send'>;

export class LambdaAsyncInvoker implements AsyncInvoker {
  constructor(
    private readonly lambda: LambdaInvokeClient,
    private readonly functionNames: Readonly<Record<AsyncTarget, string>>,
  ) {}

  async invoke(target: AsyncTarget, event: unknown): Promise<void> {
    const output = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.functionNames[target],
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify(event)),
      }),
    );
    if (output.StatusCode !== 202) {
      throw new Error(`Async invoke of ${target} was not queued (status ${output.StatusCode})`);
    }
  }
}
