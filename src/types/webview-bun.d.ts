// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
declare module 'webview-bun' {
  export class Webview {
    constructor(debug?: boolean);
    title: string;
    size: { width: number; height: number; hint: number };
    navigate(url: string): void;
    bind(name: string, fn: (...args: any[]) => any): void;
    run(): void;
  }
  export const SizeHint: {
    NONE: number;
    MIN: number;
    MAX: number;
    FIXED: number;
  };
}
