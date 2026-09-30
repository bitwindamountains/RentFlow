export type DomainStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

/**
 * An expected business-rule failure. `code` is a stable machine-readable
 * identifier the web client can branch on; `message` is safe to show users.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: DomainStatus = 400,
    message?: string,
  ) {
    super(message ?? messages[code] ?? code);
    this.name = 'DomainError';
  }
}

const messages: Record<string, string> = {
  ALLOCATION_EXCEEDS_PAYMENT: 'Allocations cannot exceed the payment amount.',
  ALREADY_A_MEMBER: 'This person already has access to this workspace.',
  CHARGE_EXISTS: 'A rent charge for this lease and billing period already exists.',
  CHARGE_HAS_PAYMENTS: 'Reverse the payments applied to this charge before voiding it.',
  CHARGE_NOT_OPEN: 'This charge is not open.',
  EMAIL_EXISTS: 'This email already has an account. Sign in instead.',
  EMAIL_NOT_VERIFIED: 'Verify your email address first.',
  FUTURE_TERMINATION_NOT_ALLOWED:
    'Lease termination takes effect immediately. Choose today or an earlier date.',
  FUTURE_PAYMENT_DATE: 'The payment date cannot be in the future.',
  IDEMPOTENCY_CONFLICT: 'This request key was already used for different details.',
  INVALID_ALLOCATION: 'An allocation does not match an open charge on this lease.',
  INVALID_CREDENTIALS: 'Check your email, password, and workspace access, then try again.',
  INVALID_DATE: 'Enter a valid date.',
  INVALID_DEPOSIT: 'The amount exceeds the deposit balance.',
  INVALID_IDEMPOTENCY_KEY: 'A valid Idempotency-Key header is required.',
  INVALID_LEASE_DATES: 'The lease dates are not valid.',
  INVALID_MONEY: 'Enter a positive amount with at most two decimal places.',
  INVALID_ROLE: 'That role cannot be assigned.',
  INVALID_TRANSITION: 'That status change is not allowed.',
  INVITATION_INVALID: 'This invitation is expired, revoked, or already used.',
  LEASE_NOT_FOUND: 'The lease was not found.',
  MAINTENANCE_NOT_FOUND: 'The work order was not found.',
  MEMBER_NOT_FOUND: 'The staff member was not found.',
  NAME_AND_STRONG_PASSWORD_REQUIRED:
    'New accounts need a name and a password of at least 12 characters.',
  OWNER_PROTECTED: 'The workspace owner cannot be changed here.',
  PASSWORD_INCORRECT: 'Your current password is incorrect.',
  PASSWORD_TOO_WEAK:
    'Use at least 12 characters that do not contain your email address.',
  PAYMENT_NOT_FOUND: 'The payment was not found.',
  PROPERTY_EXISTS: 'A property with this name already exists.',
  PROPERTY_NOT_FOUND: 'The property was not found.',
  RENT_CHANGE_AFTER_BILLED:
    'Rent for that period is already billed. Choose a later effective date.',
  RENT_CHANGE_REQUIRES_NEW_LEASE:
    'Use Change rent to set a new rent from a future date.',
  RENT_SCHEDULE_EXISTS: 'This lease already has an active rent schedule.',
  RESOURCE_NOT_FOUND: 'The requested record was not found.',
  SELF_CHANGE_NOT_ALLOWED: 'You cannot change your own access.',
  TENANT_HAS_ACTIVE_LEASE: 'End the tenant’s active leases before archiving.',
  TENANT_HAS_BALANCE: 'Settle the tenant’s balance before archiving.',
  TOKEN_INVALID: 'This link is invalid or has expired. Request a new one.',
  UNIT_EXISTS: 'A unit with this number already exists in the property.',
  UNIT_OCCUPIED: 'This unit already has an active lease.',
};

export const notFound = (code = 'RESOURCE_NOT_FOUND') =>
  new DomainError(code, 404);
export const conflict = (code: string) => new DomainError(code, 409);
