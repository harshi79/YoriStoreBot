export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "That record could not be found.") {
    super(message, "NOT_FOUND");
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "VALIDATION");
  }
}

export class InsufficientCreditsError extends DomainError {
  constructor(message = "You don't have enough credits for this item.") {
    super(message, "INSUFFICIENT_CREDITS");
  }
}

export class OutOfStockError extends DomainError {
  constructor(message = "This item just sold out. Please refresh the store.") {
    super(message, "OUT_OF_STOCK");
  }
}

export class PriceChangedError extends DomainError {
  constructor() {
    super("The price changed before confirmation. Please open the product again to review it.", "PRICE_CHANGED");
  }
}

export class BonusUnavailableError extends DomainError {
  constructor(readonly nextAvailableAt: Date) {
    super("Your daily bonus has already been claimed.", "BONUS_UNAVAILABLE");
  }
}

export class CodeUnavailableError extends DomainError {
  constructor(message = "This credit code is invalid, expired, or fully redeemed.") {
    super(message, "CODE_UNAVAILABLE");
  }
}

export class AlreadyRedeemedError extends DomainError {
  constructor() {
    super("You've already redeemed this code.", "ALREADY_REDEEMED");
  }
}
