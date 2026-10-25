import type { SlotType } from '@fisio/domain';
import type { AuthErrorCode } from '../auth';
import type { ErrorCode } from '../errors';

/**
 * Typed UI strings (docs/architecture.md §7.3). The `Strings` interface is the contract: a
 * missing or extra key is a compile error. A second language is a second module implementing
 * the same interface plus a locale switch; there is no i18n framework in v1.
 *
 * M0: error messages for every catalogued code (API and sign-in), the common words, and the
 * sections of the first pages (sign-in, therapist setup, the two home pages). Pages add their
 * own sections as they are built. Every value is a complete sentence or label: view-models
 * concatenate, templates never do.
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
  /** The sign-in page (§3.3 C1, T1). */
  readonly auth: {
    readonly title: string;
    readonly emailLabel: string;
    readonly codeLabel: string;
    readonly passwordLabel: string;
    readonly totpLabel: string;
    readonly requestCode: string;
    readonly confirmCode: string;
    readonly continueWithPassword: string;
    readonly confirmTotp: string;
    readonly codeSent: string;
    readonly changeEmail: string;
    readonly therapistLink: string;
    readonly clientLink: string;
    readonly errors: Readonly<Record<AuthErrorCode, string>>;
  };
  /** The therapist's one-time setup page (§11.5): password, then TOTP enrolment. */
  readonly setup: {
    readonly title: string;
    readonly intro: string;
    readonly passwordLabel: string;
    readonly continue: string;
    readonly totpIntro: string;
    readonly secretLabel: string;
    readonly openAuthenticator: string;
    readonly totpLabel: string;
    readonly finish: string;
    readonly invalidLink: string;
  };
  readonly home: {
    readonly greeting: string;
    readonly greetingTherapist: string;
    readonly client: {
      readonly bookingsTitle: string;
      readonly noBookings: string;
      readonly calendarSoon: string;
    };
    readonly therapist: {
      readonly title: string;
      readonly soon: string;
    };
  };
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
    internal_error: 'Si è verificato un errore imprevisto. Riprova tra poco.',
  },
  auth: {
    title: 'Accedi',
    emailLabel: 'Email',
    codeLabel: 'Codice ricevuto via email',
    passwordLabel: 'Password',
    totpLabel: 'Codice dell’app di autenticazione',
    requestCode: 'Inviami il codice',
    confirmCode: 'Accedi',
    continueWithPassword: 'Continua',
    confirmTotp: 'Accedi',
    codeSent:
      'Se l’indirizzo è registrato, ti abbiamo inviato un codice di 8 cifre. Vale 5 minuti.',
    changeEmail: 'Cambia indirizzo',
    therapistLink: 'Sei la fisioterapista? Accedi con la password',
    clientLink: 'Sei un cliente? Accedi con il codice via email',
    errors: {
      code_mismatch: 'Il codice non è corretto. Controlla e riprova.',
      code_expired: 'Il codice è scaduto. Richiedine uno nuovo.',
      too_many_attempts: 'Troppi tentativi. Attendi 15 minuti e riprova.',
      not_authorized: 'Email o password non corretti, oppure la sessione non è più valida.',
      invalid_session: 'La procedura di accesso è scaduta. Ricomincia dall’inizio.',
      invalid_password: 'La password deve avere almeno 12 caratteri.',
    },
  },
  setup: {
    title: 'Configura il tuo accesso',
    intro: 'Scegli la password con cui accederai, poi collega la tua app di autenticazione.',
    passwordLabel: 'Password (almeno 12 caratteri)',
    continue: 'Continua',
    totpIntro:
      'Aggiungi questa chiave alla tua app di autenticazione (per esempio Google Authenticator), poi inserisci il codice che mostra.',
    secretLabel: 'Chiave da inserire a mano',
    openAuthenticator: 'Apri nell’app di autenticazione',
    totpLabel: 'Codice dell’app di autenticazione',
    finish: 'Completa',
    invalidLink: 'Questo link non è valido. Chiedi un nuovo link di configurazione.',
  },
  home: {
    greeting: 'Ciao',
    greetingTherapist: 'Buongiorno',
    client: {
      bookingsTitle: 'Le tue prenotazioni',
      noBookings: 'Non hai prenotazioni in programma.',
      calendarSoon: 'Il calendario per prenotare arriva a breve.',
    },
    therapist: {
      title: 'Agenda',
      soon: 'Dashboard, calendario e clienti arrivano nei prossimi aggiornamenti.',
    },
  },
};
