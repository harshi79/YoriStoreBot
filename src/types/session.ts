export type AdminFlow =
  | { kind: "category:create:name" }
  | { kind: "category:edit:name"; categoryId: string }
  | { kind: "category:edit:description"; categoryId: string }
  | { kind: "category:edit:emoji"; categoryId: string }
  | { kind: "product:create:name"; categoryId: string }
  | { kind: "product:create:description"; categoryId: string; name: string }
  | { kind: "product:create:price"; categoryId: string; name: string; description: string }
  | { kind: "product:create:emoji"; categoryId: string; name: string; description: string; price: number }
  | { kind: "product:edit:name"; productId: string }
  | { kind: "product:edit:description"; productId: string }
  | { kind: "product:edit:planDetails"; productId: string }
  | { kind: "product:edit:instructions"; productId: string }
  | { kind: "product:edit:warranty"; productId: string }
  | { kind: "product:edit:media"; productId: string }
  | { kind: "product:edit:price"; productId: string }
  | { kind: "product:edit:emoji"; productId: string }
  | { kind: "inventory:add:payload"; productId: string }
  | { kind: "settings:bonus" }
  | { kind: "settings:referral" }
  | { kind: "broadcast:message" }
  | { kind: "broadcast:confirm"; text: string };

export type UserFlow =
  | { kind: "store:search" }
  | { kind: "warranty:reason"; purchaseId: string };

export interface PurchaseConfirmation {
  productId: string;
  nonce: string;
  telegramId: number;
  expectedPrice: number;
  quantity?: number;
  expiresAt: number;
}

export interface SessionData {
  adminFlow: AdminFlow | null;
  userFlow?: UserFlow | null;
  purchaseConfirmation: PurchaseConfirmation | null;
  adminPanelMessageId?: number;
  adminPanelChatId?: number;
}
