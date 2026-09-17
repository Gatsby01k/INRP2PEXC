/**
 * snake_case table/column mapping for Better Auth 1.7.5 (migration 0006_auth_better_auth.sql).
 * Verified by an integration test using Better Auth's own migration planner.
 */
export const userSchema = {
  modelName: 'auth_user',
  fields: { name: 'name', email: 'email', emailVerified: 'email_verified', image: 'image', createdAt: 'created_at', updatedAt: 'updated_at' },
} as const;

export const sessionSchema = {
  modelName: 'auth_session',
  fields: {
    expiresAt: 'expires_at',
    token: 'token',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    ipAddress: 'ip_address',
    userAgent: 'user_agent',
    userId: 'user_id',
  },
} as const;

export const accountSchema = {
  modelName: 'auth_account',
  fields: {
    accountId: 'account_id',
    providerId: 'provider_id',
    userId: 'user_id',
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    idToken: 'id_token',
    accessTokenExpiresAt: 'access_token_expires_at',
    refreshTokenExpiresAt: 'refresh_token_expires_at',
    scope: 'scope',
    password: 'password',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
} as const;

export const verificationSchema = {
  modelName: 'auth_verification',
  fields: { identifier: 'identifier', value: 'value', expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
} as const;

export const twoFactorSchema = {
  user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
  twoFactor: {
    modelName: 'auth_two_factor',
    fields: {
      secret: 'secret',
      backupCodes: 'backup_codes',
      userId: 'user_id',
      verified: 'verified',
      failedVerificationCount: 'failed_verification_count',
      lockedUntil: 'locked_until',
    },
  },
} as const;

export const rateLimitSchema = {
  modelName: 'auth_rate_limit',
  fields: { key: 'key', count: 'count', lastRequest: 'last_request' },
} as const;
