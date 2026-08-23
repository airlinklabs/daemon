// Re-export everything from split modules for backward compatibility.
export {
  attachActivityHook,
  authenticateSftpSession,
  generateCredential,
  getActiveSessionCount,
  getSftpActivity,
  type NativeSftpSession,
  revokeCredential,
  revokeCredentialForContainer,
  type SftpActivityEvent,
  type SftpActivityHook,
  type SftpAuthOutcome,
  type SftpCredential,
} from './sftpAuth';
export { getSftpServerPort, startNativeSftpServer } from './sftpServer';
export { rooted, serveSftp } from './sftpSubsystem';
