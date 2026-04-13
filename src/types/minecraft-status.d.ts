// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
declare module 'minecraft-status' {
  export class MinecraftServerListPing {
    static ping(version: number, host: string, port: number, timeout?: number): Promise<unknown>;
  }
}
