import type { SlotType } from '@fisio/domain';
import type { ErrorCode } from '../errors';

/**
 * Typed UI strings (docs/architecture.md §7.3). The `Strings` interface is the contract: a
 * missing or extra key is a compile error. A second language is a second module implementing
 * the same interface plus a locale switch; there is no i18n framework in v1.
 *
 * Skeleton for M0: error messages for every catalogued code and the common words the first
 * pages need. Pages add their own sections as they are built.
 */
export interface Strings {
  readonly common: {
    readonly appName: string;
    readonly loading: string;
    readonly retry: string;
    readonly cancel: string;
    readonly confirm: string;
    readonly save: string;
    readonly close: string;
    readonly signOut: string;
    readonly unexpectedError: string;
    readonly offline: string;
  };
  /** Keyed by the domain's slot types, so a new type without a label is a compile error. */
  readonly slotTypes: Readonly<Record<SlotType, string>>;
  readonly errors: Readonly<Record<ErrorCode, string>>;
}

export const strings: Strings = {
  common: {
    appName: 'Fisio Calendar',
    loading: 'Caricamento…',
    retry: 'Riprova',
    cancel: 'Annulla',
    confirm: 'Conferma',
    save: 'Salva',
    close: 'Chiudi',
    signOut: 'Esci',
    unexpectedError: 'Si è verificato un errore imprevisto. Riprova tra poco.',
    offline: 'Sembra che tu non sia connesso a Internet.',
  },
  slotTypes: {
    studio: 'Studio',
    pool: 'Piscina',
  },
  errors: {
    validation_failed: 'Alcuni dati non sono validi. Controlla i campi evidenziati.',
    unauthenticated: 'La sessione è scaduta. Accedi di nuovo.',
    forbidden: 'Non hai i permessi per questa operazione.',
    not_found: 'Elemento non trovato.',
    slot_full: 'Questo orario è al completo.',
    slot_cancelled: 'Questo orario è stato annullato.',
    slot_past: 'Questo orario è già passato.',
    slot_outside_horizon: 'Non è ancora possibile prenotare questo orario.',
    slot_changed: 'Il calendario è cambiato. Lo abbiamo aggiornato: controlla e riprova.',
    already_booked: 'Hai già una prenotazione in questo orario.',
    overlapping_booking: 'Hai già una prenotazione che si sovrappone a questo orario.',
    cutoff_passed: 'Non è più possibile disdire questa prenotazione online. Contatta lo studio.',
    rule_overlap: 'Questa regola si sovrappone a un’altra regola esistente.',
    client_exists: 'Esiste già un cliente con questo indirizzo email.',
    client_blocked: 'Operazione non consentita: il cliente è bloccato.',
    conflict_retry_exhausted:
      'Il servizio è momentaneamente occupato. Riprova tra qualche istante.',
  },
};
