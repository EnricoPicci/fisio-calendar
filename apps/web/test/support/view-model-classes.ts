import type { ViewModelClass } from '@fisio/testkit';
import { ViewModel } from '../../src/app/view-model';
import { FormViewModel } from '../../src/viewmodels/form-view-model';

/**
 * Every concrete view-model class of `src/viewmodels`, found by loading the folder, so a new
 * view-model is covered by the surface check without being listed anywhere.
 */
const modules = import.meta.glob<Record<string, unknown>>(
  ['../../src/viewmodels/*.ts', '!../../src/viewmodels/*.spec.ts'],
  { eager: true },
);

/** The abstract bases: their own members are covered by their own specs, not per subclass. */
export const VIEW_MODEL_BASES: readonly ViewModelClass[] = [ViewModel, FormViewModel];

export const VIEW_MODEL_CLASSES: readonly ViewModelClass[] = Object.values(modules)
  .flatMap((exports) => Object.values(exports))
  .filter(
    (value): value is ViewModelClass =>
      typeof value === 'function' &&
      value.prototype instanceof ViewModel &&
      !VIEW_MODEL_BASES.includes(value as ViewModelClass),
  )
  .sort((a, b) => a.name.localeCompare(b.name));
