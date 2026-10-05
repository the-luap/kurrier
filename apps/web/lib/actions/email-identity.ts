"use server";

import {
    createSecret,
    db, deleteSecretAdmin,
    identities,
    IdentityCreate,
    IdentityInsertSchema, smtpAccounts, smtpAccountSecrets, updateSecret,
} from "@db";
import {
    defaultImapQuota,
    FormState, handleAction,
} from "@schema";
import { readSessionToken as currentSession } from "@/lib/auth-session";
import {getWorkspaceId, rlsClient} from "@/lib/actions/clients";
import { checkDefaultWorkspaceIdentity } from "@/lib/actions/workspace";
import {assignIdentityToAllWorkspaceMembers, fetchDecryptedSecrets, initializeMailboxes} from "@/lib/actions/dashboard";
import {createMailer, VerifyResult} from "@providers";
import {eq} from "drizzle-orm";
import {access} from "@/lib/actions/shared";
import {requireWorkspaceAdmin} from "@/lib/actions/authz";
import {isMetadataOrLinkLocalAddress} from "@/lib/safe-url";

/**
 * SMTP/IMAP hosts are admin supplied and may legitimately be on the LAN
 * (self-hosted mail servers); cloud metadata / link-local targets are not.
 */
function assertAllowedMailHosts(config: Record<string, unknown>) {
    for (const key of ["SMTP_HOST", "IMAP_HOST"]) {
        const host = config[key];
        if (typeof host === "string" && host.trim() && isMetadataOrLinkLocalAddress(host.trim())) {
            throw new Error(`${key} is not allowed`);
        }
    }
}

export type CreateEmailIdentityInput = {
    email: string;
    displayName?: string;
    smtpAccountId: string;
    dailyQuota?: number;
};

export async function createEmailIdentity(
    input: CreateEmailIdentityInput,
): Promise<FormState> {
    // Public endpoint: owners/admins only, and the SMTP account must be one
    // of this workspace (the identity is inserted with the admin client).
    const { workspaceId, userId } = await requireWorkspaceAdmin();

    const rls = await rlsClient();
    const [smtpAccount] = await rls((tx) =>
        tx
            .select({ id: smtpAccounts.id })
            .from(smtpAccounts)
            .where(eq(smtpAccounts.id, String(input?.smtpAccountId ?? "")))
            .limit(1),
    );
    if (!smtpAccount) {
        return { success: false, error: "SMTP account not found" };
    }

    const identityData = IdentityInsertSchema.parse({
        workspaceId,
        ownerId: userId,
        kind: "email",
        value: input.email,
        displayName: input.displayName || input.email,
        smtpAccountId: input.smtpAccountId,
        sharedWithWorkspace: true,
        metaData: {
            dailyQuota: input.dailyQuota || defaultImapQuota,
            sharedWithWorkspace: true,
        },
    });

    const [identity] = await db
        .insert(identities)
        .values(identityData as IdentityCreate)
        .returning();

    await checkDefaultWorkspaceIdentity();
    await assignIdentityToAllWorkspaceMembers(identity);
    await initializeMailboxes(identity, userId, workspaceId);

    return {
        success: true,
        message: "dashboard.addedNewIdentity",
    };
}

export async function verifySMTPAccount(
    smtpAccountId: string,
): Promise<FormState<VerifyResult>> {
    return handleAction(async () => {
        await requireWorkspaceAdmin();
        const [smtpSecret] = await fetchDecryptedSecrets({
            linkTable: smtpAccountSecrets,
            foreignCol: smtpAccountSecrets.accountId,
            secretIdCol: smtpAccountSecrets.secretId,
            parentId: smtpAccountId,
        });

        if (!smtpSecret) {
            throw new Error("SMTP account secret not found");
        }

        const parsedVaultValues = smtpSecret.parsedSecret;
        const session = await currentSession();
        const workspaceId = await getWorkspaceId();

        const mailer = createMailer("smtp", parsedVaultValues);
        const res = await mailer.verify(smtpAccountId);

        parsedVaultValues.sendVerified = res?.meta?.send;
        parsedVaultValues.receiveVerified = res?.meta?.receive;

        await updateSecret(session, workspaceId, smtpSecret.metaId, {
            value: JSON.stringify(parsedVaultValues),
        });

        return {
            success: res.ok,
            message: res.message,
            data: res,
        };
    });
}

export type CreateSMTPAccountInput = {
    label?: string;
    ulid: string;
    required: Record<string, unknown>;
    optional?: Record<string, unknown>;
};

export async function createSMTPAccount(
    input: CreateSMTPAccountInput,
): Promise<FormState<{ accountId: string }>> {
    return handleAction(async () => {
        const { workspaceId } = await requireWorkspaceAdmin();
        const session = await currentSession();

        const { canCreateProvider, reason } = await access("canCreateProvider");
        if (!canCreateProvider) {
            return {
                success: false,
                error:
                    reason ??
                    "dashboard.providerCreationDisabled",
            };
        }


        const rls = await rlsClient();

        const smtpConfig: Record<string, unknown> = {
            ulid: input.ulid,
            label: String(input.label || "My SMTP Account").trim(),
            ...input.required,
            ...input.optional,
        };
        assertAllowedMailHosts(smtpConfig);

        const secretMeta = await createSecret(session, workspaceId, {
            name: input.ulid,
            value: JSON.stringify(smtpConfig),
        });

        const [smtpAccount] = await rls((tx) =>
            tx
                .insert(smtpAccounts)
                .values({})
                .returning(),
        );

        await rls((tx) =>
            tx
                .insert(smtpAccountSecrets)
                .values({
                    accountId: smtpAccount.id,
                    secretId: secretMeta.id,
                }),
        );

        const verification = await verifySMTPAccount(smtpAccount.id);

        if (!verification.success) {
            await rls((tx) =>
                tx
                    .delete(smtpAccounts)
                    .where(eq(smtpAccounts.id, smtpAccount.id)),
            );

            await deleteSecretAdmin(secretMeta.id);

            return {
                success: false,
                error:
                    verification.error ||
                    verification.message ||
                    "SMTP verification failed",
            };
        }

        return {
            success: true,
            message: verification.message || "dashboard.done",
            data: {
                accountId: smtpAccount.id,
            },
        };
    });
}


export type UpdateSMTPAccountInput = {
    accountId: string;
    label?: string;
    ulid: string;
    required: Record<string, unknown>;
    optional?: Record<string, unknown>;
};

export async function updateSMTPAccount(
    input: UpdateSMTPAccountInput,
): Promise<FormState<{ accountId: string }>> {
    return handleAction(async () => {
        const { workspaceId } = await requireWorkspaceAdmin();
        const session = await currentSession();

        const { canCreateProvider, reason } = await access("canCreateProvider");
        if (!canCreateProvider) {
            return {
                success: false,
                error:
                    reason ??
                    "dashboard.providerCreationDisabled",
            };
        }

        const [smtpSecret] = await fetchDecryptedSecrets({
            linkTable: smtpAccountSecrets,
            foreignCol: smtpAccountSecrets.accountId,
            secretIdCol: smtpAccountSecrets.secretId,
            parentId: input.accountId,
        });

        if (!smtpSecret) {
            return {
                success: false,
                error: "SMTP account not found",
            };
        }

        const previousConfig = { ...smtpSecret.parsedSecret };

        const smtpConfig: Record<string, unknown> = {
            ulid: input.ulid,
            label: String(input.label || "My SMTP Account").trim(),
            ...input.required,
            ...input.optional,
        };
        assertAllowedMailHosts(smtpConfig);

        await updateSecret(session, workspaceId, smtpSecret.metaId, {
            name: input.ulid,
            value: JSON.stringify(smtpConfig),
        });

        const verification = await verifySMTPAccount(input.accountId);

        if (!verification.success) {
            await updateSecret(session, workspaceId, smtpSecret.metaId, {
                name: String(previousConfig.ulid),
                value: JSON.stringify(previousConfig),
            });

            return {
                success: false,
                error:
                    verification.error ||
                    verification.message ||
                    "SMTP verification failed",
            };
        }

        return {
            success: true,
            message: verification.message || "dashboard.done",
            data: {
                accountId: input.accountId,
            },
        };
    });
}
