export interface MiniConfig {
  demoMode: boolean;
  ready: boolean;
  botUsername: string | null;
  supportUrl: string;
}

export interface CategoryDto { id: string; name: string; emoji: string; count: number }
export interface ProductDto {
  id: string;
  name: string;
  description: string;
  planDetails: string;
  deliveryInstructions: string;
  price: number;
  emoji: string;
  featured: boolean;
  isUnlimited: boolean;
  warrantyHours: number;
  stock: number;
  category: { id: string; name: string; emoji: string };
}
export interface CatalogDto { products: ProductDto[]; categories: CategoryDto[]; total: number; page: number; pages: number }

export interface ProfileDto {
  id: string;
  telegramId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
  credits: number;
  createdAt: string;
  isOwner: boolean;
  stats: { orders: number; items: number; spent: number; saved: number };
  bonus: { credits: number; periodHours: number; available: boolean; nextAvailableAt: string | null; remainingMs: number };
  referrals: { count: number; earned: number; reward: number; welcome: number; enabled: boolean; link: string | null };
}

export interface TransactionDto { amount: number; type: string; description: string; balanceAfter: number; createdAt: string }
export interface WalletDto { transactions: TransactionDto[]; total: number; page: number; pages: number }
export interface OrderDto {
  id: string;
  productId: string;
  productName: string;
  productEmoji: string;
  category: string;
  paid: number;
  quantity: number;
  createdAt: string;
  warrantyHours: number;
  claimStatus: string | null;
}
export interface OrderItemDto {
  id: string;
  payload: string;
  claim: { id: string; status: string; reason: string; resolutionNote: string | null } | null;
  replaced: boolean;
}
export interface OrderDetailDto extends OrderDto {
  planDetails: string;
  deliveryInstructions: string;
  warrantyExpiresAt: string;
  items: OrderItemDto[];
}
export interface OrdersDto { orders: OrderDto[]; total: number; page: number; pages: number }
export interface PurchaseDto { purchaseId: string; productName: string; paid: number; quantity: number; remainingCredits: number; repeated: boolean }
export interface AuthDto { token: string; expiresAt: string }
