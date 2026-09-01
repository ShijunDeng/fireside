export type DialogToken = symbol;

export type OverflowStyle = {
  overflow: string;
};

export type DialogStackOptions = {
  getBodyStyle?: () => OverflowStyle | null;
};

export type DialogStack = {
  register: (token: DialogToken) => () => void;
  isTop: (token: DialogToken) => boolean;
  isRegistered: (token: DialogToken) => boolean;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly DialogToken[];
};

export function createDialogToken(label = 'dialog'): DialogToken {
  return Symbol(label);
}

const browserBodyStyle = () => (
  typeof document === 'undefined' ? null : document.body?.style ?? null
);

export function createDialogStack(options: DialogStackOptions = {}): DialogStack {
  const getBodyStyle = options.getBodyStyle ?? browserBodyStyle;
  const registrations = new Map<DialogToken, Set<symbol>>();
  const listeners = new Set<() => void>();
  let snapshot: readonly DialogToken[] = Object.freeze([]);
  let lockedStyle: OverflowStyle | null = null;
  let originalOverflow: string | undefined;

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  const lockBody = () => {
    lockedStyle = getBodyStyle();
    if (!lockedStyle) return;
    originalOverflow = lockedStyle.overflow;
    lockedStyle.overflow = 'hidden';
  };

  const unlockBody = () => {
    if (lockedStyle && originalOverflow !== undefined) {
      lockedStyle.overflow = originalOverflow;
    }
    lockedStyle = null;
    originalOverflow = undefined;
  };

  const register = (token: DialogToken) => {
    const registration = Symbol('dialog-registration');
    let tokenRegistrations = registrations.get(token);
    if (!tokenRegistrations) {
      if (snapshot.length === 0) lockBody();
      else if (lockedStyle) lockedStyle.overflow = 'hidden';
      tokenRegistrations = new Set();
      registrations.set(token, tokenRegistrations);
      snapshot = Object.freeze([...snapshot, token]);
      notify();
    }
    tokenRegistrations.add(registration);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const activeRegistrations = registrations.get(token);
      if (!activeRegistrations?.delete(registration) || activeRegistrations.size > 0) return;

      registrations.delete(token);
      snapshot = Object.freeze(snapshot.filter((candidate) => candidate !== token));
      if (snapshot.length === 0) unlockBody();
      else if (lockedStyle) lockedStyle.overflow = 'hidden';
      notify();
    };
  };

  const isTop = (token: DialogToken) => snapshot.at(-1) === token;
  const isRegistered = (token: DialogToken) => registrations.has(token);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
    };
  };
  const getSnapshot = () => snapshot;

  return { register, isTop, isRegistered, subscribe, getSnapshot };
}

export const dialogStack = createDialogStack();
