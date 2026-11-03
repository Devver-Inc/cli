import LogtoClient, { UserScope } from "@logto/node";

import { Storage } from "../storage";

const logtoPath = (key: string) => `logto/${key}`;

const storage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      if (!(await Storage.fileExists(logtoPath(key)))) {
        return null;
      }
      return await Storage.readToString(logtoPath(key));
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await Storage.write(logtoPath(key), value);
  },
  removeItem: async (key: string): Promise<void> => {
    await Storage.deleteFile(logtoPath(key)).catch(() => undefined);
  },
};

export function createLogtoClient(onNavigate?: (url: string) => void) {
  return new LogtoClient(
    {
      appId: "ihq9chjvnkq0x81qeoi4m",
      endpoint: "https://auth.devver.app/",
      scopes: [
        UserScope.Organizations,
        UserScope.Email,
        UserScope.Profile,
        UserScope.OrganizationRoles,
        UserScope.Roles,
        UserScope.CustomData,
      ],
      resources: ["http://localhost:9999"],
    },
    {
      navigate: (url) => {
        onNavigate?.(url);
      },
      storage,
    }
  );
}
