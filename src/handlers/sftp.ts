// The native SFTP implementation (src/handlers/nativeSftp.ts) replaces the
// legacy atmoz/sftp sidecar container. This module is kept as a thin facade
// so existing route/panel imports keep working unchanged.

export type { SftpActivityEvent, SftpActivityHook, SftpCredential } from './nativeSftp';
export {
  attachActivityHook,
  generateCredential,
  getActiveSessionCount,
  getSftpActivity,
  revokeCredential,
  revokeCredentialForContainer,
} from './nativeSftp';
