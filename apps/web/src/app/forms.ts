import type { FormEvent } from 'react';

/**
 * Binds a form's submit to a view-model method (docs/architecture.md §7.1: templates call
 * methods from event handlers). Inputs stay uncontrolled; their values are read once, on submit,
 * by `name`. The handler's promise is not awaited: `busy$` is how the template follows it.
 */
export function onSubmit(
  handler: (fields: Fields) => unknown,
): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault();
    void handler(new Fields(new FormData(event.currentTarget)));
  };
}

export class Fields {
  readonly #data: FormData;

  constructor(data: FormData) {
    this.#data = data;
  }

  /** The trimmed value of the field, '' when absent. */
  get(name: string): string {
    const value = this.#data.get(name);
    return typeof value === 'string' ? value.trim() : '';
  }
}
