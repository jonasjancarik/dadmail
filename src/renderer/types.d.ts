export {};

declare global {
  interface Window {
    electronAPI: {
      getEmails: (searchQuery?: string) => Promise<any[]>;
      getEmail: (id: number) => Promise<any>;
      deleteEmail: (id: number) => Promise<{ success: boolean }>;
      getSettings: () => Promise<Record<string, string>>;
      saveSettings: (settings: Record<string, string>) => Promise<{ success: boolean }>;
      sendEmail: (emailData: { to: string; subject: string; text: string; replyToId?: number }) => Promise<{ success: boolean; error?: string }>;
      testConnection: (credentials: { email: string; password: string }) => Promise<{ success: boolean; error?: string }>;
      onEmailsUpdated: (callback: (count: number) => void) => () => void;
      onSyncStatus: (callback: (status: { status: string; message: string; progress?: number }) => void) => () => void;
      clearEmails: () => Promise<{ success: boolean; error?: string }>;
      reprocessEmails: () => Promise<{ success: boolean; processed: number; error?: string }>;
    };
  }
}

