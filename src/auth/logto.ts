import LogtoClient, { UserScope } from "@logto/node";
import { Storage } from "../storage";

class LogtoStorageAdapter {
  private readonly getLogtoPath = (key: string) => `logto/${key}`;

  async getItem(key: string): Promise<string | null> {
    try {
      const exists = await Storage.fileExists(this.getLogtoPath(key));
      if (!exists) {
        return null;
      }
      return await Storage.readToString(this.getLogtoPath(key));
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    await Storage.write(this.getLogtoPath(key), value);
  }

  async removeItem(key: string): Promise<void> {
    try {
      await Storage.deleteFile(this.getLogtoPath(key));
    } catch {
      // Ignore errors if file doesn't exist
    }
  }
}

export function createLogtoClient(onNavigate?: (url: string) => void) {
  return new LogtoClient(
    {
      appId: "wat2nrbr150jagrlpwl04",
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
      storage: new LogtoStorageAdapter(),
    }
  );
}
