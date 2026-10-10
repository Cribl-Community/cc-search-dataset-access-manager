export {};

declare global {
  interface CriblUser {
    id: string;
    username: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    initials?: string;
  }

  interface Window {
    CRIBL_API_URL?: string;
    CRIBL_BASE_PATH?: string;
    getCriblUser?: () => Promise<CriblUser>;
  }
}
