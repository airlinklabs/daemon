declare module "bun" {
  export type ServerWebSocket<T = unknown> = {
    data: T;
    readyState: number;
    send(data: string | Buffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
  };
}

declare const Bun: any;
