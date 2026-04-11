declare module 'minecraft-status' {
  export class MinecraftServerListPing {
    static ping(
      version: number,
      host: string,
      port: number,
      timeout?: number,
    ): Promise<unknown>;
  }
}
