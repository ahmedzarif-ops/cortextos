import { chmodSync, existsSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { spawnSync } from 'child_process';

export interface SecretPermissionCommandResult {
  status: number | null;
  error?: Error;
}

export interface SecretPermissionDependencies {
  platform: NodeJS.Platform;
  chmod: (path: string, mode: number) => void;
  secureWindowsAcl: (path: string) => SecretPermissionCommandResult;
}

// Use the current process token's SID rather than USERNAME/USERDOMAIN. Azure,
// local, Microsoft-account, and domain identities do not share one reliable
// textual account-name format. Replacing (rather than merely disabling)
// inherited rules prevents a pre-existing broad explicit ACL from surviving.
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:CTX_SECRET_FILE
if ([string]::IsNullOrWhiteSpace($target)) { throw 'CTX_SECRET_FILE is missing' }
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
# Request SecurityIdentifier objects explicitly. The convenience .Access
# property translates every ACE to an NTAccount; hosted/build-machine ACLs can
# contain stale image-provisioning SIDs whose names no longer resolve. We must
# still remove those ACEs rather than fail before replacing the DACL.
$existingRules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in @($existingRules)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $full, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, $full, $allow)))
$acl.SetOwner($userSid)
Set-Acl -LiteralPath $target -AclObject $acl
`;

function secureWindowsAcl(path: string): SecretPermissionCommandResult {
  const encoded = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      env: { ...process.env, CTX_SECRET_FILE: path },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true,
    },
  );
  return { status: result.status, error: result.error };
}

const defaultDependencies: SecretPermissionDependencies = {
  platform: platform(),
  chmod: chmodSync,
  secureWindowsAcl,
};

/**
 * Restrict a credential-bearing file to the current user.
 *
 * POSIX uses mode 0600. Windows replaces inherited and explicit access rules
 * with FullControl for the current process identity and LocalSystem. Throwing
 * is deliberate: writing a token and silently failing to protect it is not a
 * successful onboarding outcome.
 */
export function restrictSecretFile(
  path: string,
  dependencies: Partial<SecretPermissionDependencies> = {},
): void {
  const deps: SecretPermissionDependencies = { ...defaultDependencies, ...dependencies };
  if (deps.platform !== 'win32') {
    deps.chmod(path, 0o600);
    return;
  }

  const result = deps.secureWindowsAcl(path);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || `PowerShell exited ${String(result.status)}`;
    throw new Error(`Could not restrict Windows permissions for secret file: ${reason}`);
  }
}

/**
 * Write a UTF-8 secret without ever leaving the credential contents behind in
 * a file whose ACL has not already been restricted. In-place writes preserve
 * the established Windows ACL; the second check guards unusual filesystems.
 */
export function writeSecretFileSync(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 });
  restrictSecretFile(path);
  writeFileSync(path, content, 'utf-8');
  restrictSecretFile(path);
}

export const secretPermissionInternals = {
  WINDOWS_ACL_SCRIPT,
};
