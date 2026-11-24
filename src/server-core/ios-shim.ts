// 0.14.0: the iPhone and iPad app's own modules (src/ios/*) in the server's core build
// (vite.core.config.ts sends them here). They are only ever loaded on an iPhone, through a dynamic
// import the server never makes; without this the bundler still follows those imports and pulls in
// Capacitor's iOS plugins, which don't build for Node.
const NOT_HERE = 'Not on the Restock server (the iPhone and iPad app only).';
const refuse = () => {
  throw new Error(NOT_HERE);
};

export class RestockIos {
  constructor() {
    refuse();
  }
}
export const appleHere = () => false;
export const RestockApple = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : refuse) });
export const wifi = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : refuse) });
export const icloud = wifi;
export const appleLan = () => undefined;
export const bridgeLan = refuse;
export const lanHere = () => false;
export const toB64 = refuse;
export const fromB64 = refuse;
export const open = refuse;
export const seal = refuse;
