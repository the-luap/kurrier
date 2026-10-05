"use client";

import "@mantine/tiptap/styles.css";

import React, {
    useActionState,
    useEffect, useMemo,
    useReducer,
    useRef,
    useState,
} from "react";
import Form from "next/form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";

import {
    Link,
    RichTextEditor,
} from "@mantine/tiptap";
import {
    useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";

import type {
    MessageEntity,
} from "@db";
import type {
    FormState,
    PublicConfig,
} from "@schema";

import {
    useOptionalDictionary,
} from "@/components/providers/dictionary-provider";
import {
    type FetchIdentityMailboxListResult,
    sendMail,
} from "@/lib/actions/mailbox";
import {
    createAttachmentDownloadUrl,
    createAttachmentUploadUrl,
} from "@/lib/actions/uploads-actions";
import {
    listEmailSignatures,
    type EmailSignatureResult,
} from "@/lib/actions/email-signatures";
import {
    type DraftPayload,
    deleteDraft,
    fetchDraftForMessage,
    fetchForwardableAttachments,
    saveDraft,
} from "@/lib/actions/drafts";
import type { InitialDraft } from "./draft-events";

import {
    toEmailHtml,
    validateAttachment,
} from "./composer-utils";
import AiDraftPanel from "./ai-draft-panel";
import MailComposerBody from "./mail-composer-body";
import MailComposerFooter from "./mail-composer-footer";
import MailComposerHeader from "./mail-composer-header";

type ComposerMode =
    | "compose"
    | "reply"
    | "forward";

export type ComposerAttachment = {
    path: string;
    sizeBytes: number;
    messageId: string;
    filenameOriginal: string;
    contentType: string;
    /** Attachment of the forwarded original message. */
    forwarded?: boolean;
};

export type ComposerUpload = {
    id: string;
    name: string;
    size: number;
    progress: number;
    status:
        | "uploading"
        | "done"
        | "error";
    error?: string;
    path?: string;
    forwarded?: boolean;
};

type MailComposerProps = {
    message?: MessageEntity | null;
    publicConfig: PublicConfig;
    identityMailboxes:
        FetchIdentityMailboxListResult;
    activeIdentityPublicId?: string;
    initialMode?: ComposerMode;
    /** Draft to continue (compose drafts opened from the drafts list). */
    initialDraft?: InitialDraft;
    onClose?: () => void;
};

import { renderEmailFragment } from "@email-editor";

const AUTOSAVE_DELAY_MS = 1500;

const splitAddresses = (value?: string) =>
    String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

function parseDraftAttachments(
    value?: string,
): ComposerAttachment[] {
    try {
        const list = JSON.parse(value || "[]");
        if (!Array.isArray(list)) return [];
        return list
            .filter((item) => item && typeof item.path === "string")
            .map((item) => ({
                path: String(item.path),
                sizeBytes: Number(item.sizeBytes ?? 0),
                messageId: String(item.messageId ?? ""),
                filenameOriginal: String(
                    item.filenameOriginal ?? "attachment",
                ),
                contentType: String(
                    item.contentType ?? "application/octet-stream",
                ),
                forwarded: item.forwarded === true || undefined,
            }));
    } catch {
        return [];
    }
}

const uploadsFromAttachments = (
    list: ComposerAttachment[],
): ComposerUpload[] =>
    list.map((attachment) => ({
        id: `${attachment.forwarded ? "fwd" : "upl"}:${attachment.path}`,
        name: attachment.filenameOriginal,
        size: attachment.sizeBytes,
        progress: 100,
        status: "done",
        path: attachment.path,
        forwarded: attachment.forwarded,
    }));

/** Draft fields that count as "written something" (not sender/signature). */
const contentKey = (payload: DraftPayload) =>
    JSON.stringify([
        payload.to,
        payload.cc,
        payload.bcc,
        payload.subject,
        payload.bodyHtml,
        payload.attachments,
    ]);

export default function MailComposer({
                                         message = null,
                                         publicConfig,
                                         identityMailboxes,
                                         activeIdentityPublicId,
                                         initialMode = "compose",
                                         initialDraft = null,
                                         onClose,
                                     }: MailComposerProps) {
    const dict =
        useOptionalDictionary();

    const router = useRouter();

    const [mode, setMode] =
        useState<ComposerMode>(
            initialDraft?.payload.mode ??
            initialMode,
        );

    // ---- Draft state -----------------------------------------------------
    // Compose drafts arrive as a prop; reply/forward drafts are looked up for
    // the message when the composer opens (see below).
    const [
        restoredDraft,
        setRestoredDraft,
    ] = useState<InitialDraft>(
        initialDraft,
    );

    const [draftReady, setDraftReady] =
        useState(
            () => !message || !!initialDraft,
        );

    const [draftId, setDraftId] =
        useState<string | null>(
            initialDraft?.id ?? null,
        );

    const draftIdRef = useRef<
        string | null
    >(initialDraft?.id ?? null);

    // Identity/signature of a restored draft win over the defaults.
    const draftIdentityRef = useRef(
        Boolean(
            initialDraft?.payload
                .identityPublicId,
        ),
    );

    const draftSignatureRef = useRef<
        string | null
    >(
        initialDraft
            ? (initialDraft.payload
                .signaturePublicId ?? "")
            : null,
    );

    const formRef =
        useRef<HTMLFormElement>(null);
    const snapshotRef = useRef<{
        payload: DraftPayload;
        identityPublicId: string;
    } | null>(null);
    const lastSavedRef = useRef(
        initialDraft
            ? JSON.stringify(
                initialDraft.payload,
            )
            : "",
    );
    // What the composer opened with: an untouched composer creates no draft.
    const baselineRef = useRef<
        string | null
    >(null);
    const saveTimerRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    const saveChainRef = useRef<
        Promise<unknown>
    >(Promise.resolve());
    // Set while sending / discarding: no autosave may (re)create the draft.
    const sendingRef = useRef(false);
    const savedSomethingRef =
        useRef(false);
    const routerRef = useRef(router);
    routerRef.current = router;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const [discarding, setDiscarding] =
        useState(false);

    const [
        recipientsVersion,
        bumpRecipientsVersion,
    ] = useReducer(
        (value: number) => value + 1,
        0,
    );

    const [
        isDraggingFiles,
        setIsDraggingFiles,
    ] = useState(false);

    const dragDepthRef = useRef(0);

    const [subject, setSubject] =
        useState(() => {
            if (initialDraft) {
                return (
                    initialDraft.payload
                        .subject ?? ""
                );
            }

            if (!message) {
                return "";
            }

            const original =
                message.subject?.trim() ||
                "";

            const cleaned =
                original.replace(
                    /^(re|fwd)\s*:\s*/gi,
                    "",
                );

            if (
                initialMode === "reply"
            ) {
                return `${
                    dict?.mailbox
                        ?.replyPrefix ??
                    "Re: "
                }${cleaned}`;
            }

            if (
                initialMode ===
                "forward"
            ) {
                return `${
                    dict?.mailbox
                        ?.forwardPrefix ??
                    "Fwd: "
                }${cleaned}`;
            }

            return original;
        });

    const [html, setHtml] =
        useState("");

    const [text, setText] =
        useState("");

    const [
        identityPublicId,
        setIdentityPublicId,
    ] = useState(() => {
        const draftIdentity =
            initialDraft?.payload
                .identityPublicId;

        if (
            draftIdentity &&
            identityMailboxes.some(
                (item) =>
                    item.identity
                        .publicId ===
                    draftIdentity,
            )
        ) {
            return draftIdentity;
        }

        return (
            activeIdentityPublicId ??
            identityMailboxes[0]
                ?.identity.publicId ??
            ""
        );
    });

    const [
        signatures,
        setSignatures,
    ] = useState<
        EmailSignatureResult[]
    >([]);

    const [
        signaturePublicId,
        setSignaturePublicId,
    ] = useState(
        initialDraft?.payload
            .signaturePublicId ?? "",
    );

    const [
        signaturesLoading,
        setSignaturesLoading,
    ] = useState(false);

    const [uploads, setUploads] =
        useState<ComposerUpload[]>(() =>
            uploadsFromAttachments(
                parseDraftAttachments(
                    initialDraft?.payload
                        .attachments,
                ),
            ),
        );

    const [
        attachments,
        setAttachments,
    ] = useState<
        ComposerAttachment[]
    >(() =>
        parseDraftAttachments(
            initialDraft?.payload
                .attachments,
        ),
    );

    const fileInputRef =
        useRef<HTMLInputElement | null>(
            null,
        );

    const newMessageId =
        useRef(uuidv4());

    const editor = useEditor({
        immediatelyRender: false,
        extensions: [
            StarterKit,
            Link,
            Image,
        ],
        parseOptions: {
            preserveWhitespace: "full",
        },
        onUpdate: ({ editor }) => {
            setHtml(
                toEmailHtml(
                    editor.getHTML(),
                ),
            );

            // Single line breaks between paragraphs in the plain-text part.
            setText(
                editor
                    .getText({
                        blockSeparator:
                            "\n",
                    })
                    .trim(),
            );
        },
    });

    const [
        formState,
        formAction,
        isPending,
    ] = useActionState<
        FormState,
        FormData
    >(sendMail, {});

    useEffect(() => {
        if (!editor) {
            return;
        }

        editor.commands.focus("end");
    }, [editor]);

    useEffect(() => {
        if (
            !activeIdentityPublicId ||
            draftIdentityRef.current
        ) {
            return;
        }

        setIdentityPublicId(
            activeIdentityPublicId,
        );
    }, [activeIdentityPublicId]);

    useEffect(() => {
        let cancelled = false;

        if (!identityPublicId) {
            setSignatures([]);
            setSignaturePublicId("");
            setSignaturesLoading(false);
            return;
        }

        const loadSignatures =
            async () => {
                setSignaturesLoading(true);

                try {
                    const items =
                        await listEmailSignatures(
                            identityPublicId,
                        );

                    if (cancelled) {
                        return;
                    }

                    setSignatures(items);

                    // A restored draft keeps the signature it was written
                    // with (once; later identity changes use defaults).
                    const draftSignature =
                        draftSignatureRef.current;

                    if (
                        draftSignature !== null
                    ) {
                        draftSignatureRef.current =
                            null;

                        if (
                            !draftSignature ||
                            items.some(
                                (item) =>
                                    item.publicId ===
                                    draftSignature,
                            )
                        ) {
                            setSignaturePublicId(
                                draftSignature,
                            );
                            return;
                        }
                    }

                    const defaultSignature =
                        mode === "compose"
                            ? items.find(
                                (
                                    item,
                                ) =>
                                    item.isDefaultForNew,
                            )
                            : items.find(
                                (
                                    item,
                                ) =>
                                    item.isDefaultForReplyForward,
                            );

                    setSignaturePublicId(
                        defaultSignature
                            ?.publicId ??
                        "",
                    );
                } catch (error) {
                    if (cancelled) {
                        return;
                    }

                    setSignatures([]);
                    setSignaturePublicId(
                        "",
                    );

                    toast.error(
                        dict?.common
                            ?.error ??
                        "Error",
                        {
                            description:
                                error instanceof
                                Error
                                    ? error.message
                                    : "Failed to load signatures",
                        },
                    );
                } finally {
                    if (!cancelled) {
                        setSignaturesLoading(
                            false,
                        );
                    }
                }
            };

        void loadSignatures();

        return () => {
            cancelled = true;
        };
    }, [
        identityPublicId,
        mode,
        dict,
    ]);

    // React to each send result once: the parent passes an inline onClose,
    // so this effect re-runs on every parent render and would repeat the
    // toast (and the close) for the same result.
    const handledFormStateRef =
        useRef<FormState | null>(null);

    useEffect(() => {
        if (
            handledFormStateRef.current ===
            formState
        ) {
            return;
        }

        handledFormStateRef.current =
            formState;

        if (formState.error) {
            // Not sent: autosave resumes.
            sendingRef.current = false;

            toast.error(
                dict?.common?.error ??
                "Error",
                {
                    description:
                    formState.error,
                },
            );

            return;
        }

        if (formState.success) {
            // The server deleted the submitted draft; also drop one that a
            // save still in flight may have created meanwhile.
            void saveChainRef.current.then(
                async () => {
                    const leftover =
                        draftIdRef.current;
                    draftIdRef.current = null;
                    if (leftover) {
                        await deleteDraft(
                            leftover,
                        ).catch(() => {});
                    }
                    // Drafts list and sidebar count.
                    if (
                        leftover ||
                        savedSomethingRef.current
                    ) {
                        routerRef.current.refresh();
                    }
                },
            );

            toast.success(
                dict?.common?.success ??
                "Success",
                {
                    // `success` is a boolean; only a message is text.
                    description:
                    formState.message,
                },
            );

            onClose?.();
        }
    }, [
        formState,
        dict,
        onClose,
    ]);

    const uploadFile = async (
        file: File,
    ) => {
        const validationError =
            validateAttachment(
                file,
                dict,
            );

        if (validationError) {
            toast.error(
                dict?.common?.error ??
                "Error",
                {
                    description:
                    validationError,
                },
            );

            return;
        }

        const uploadId = uuidv4();

        setUploads((current) => [
            ...current,
            {
                id: uploadId,
                name: file.name,
                size: file.size,
                progress: 0,
                status: "uploading",
            },
        ]);

        try {
            const {
                uploadUrl,
                key,
            } =
                await createAttachmentUploadUrl(
                    {
                        fileName:
                        file.name,
                        contentType:
                        file.type,
                        messageId:
                        newMessageId.current,
                    },
                );

            await new Promise<void>(
                (resolve, reject) => {
                    const xhr =
                        new XMLHttpRequest();

                    xhr.open(
                        "PUT",
                        uploadUrl,
                    );

                    xhr.setRequestHeader(
                        "Content-Type",
                        file.type ||
                        "application/octet-stream",
                    );

                    xhr.upload.onprogress =
                        (event) => {
                            if (
                                !event.lengthComputable
                            ) {
                                return;
                            }

                            const progress =
                                Math.round(
                                    (event.loaded /
                                        event.total) *
                                    100,
                                );

                            setUploads(
                                (
                                    current,
                                ) =>
                                    current.map(
                                        (
                                            upload,
                                        ) =>
                                            upload.id ===
                                            uploadId
                                                ? {
                                                    ...upload,
                                                    progress,
                                                }
                                                : upload,
                                    ),
                            );
                        };

                    xhr.onload = () => {
                        if (
                            xhr.status >=
                            200 &&
                            xhr.status < 300
                        ) {
                            resolve();
                            return;
                        }

                        reject(
                            new Error(
                                `${
                                    dict
                                        ?.mailbox
                                        ?.uploadFailedPrefix ??
                                    "Upload failed: "
                                }${xhr.status}`,
                            ),
                        );
                    };

                    xhr.onerror = () => {
                        reject(
                            new Error(
                                dict
                                    ?.mailbox
                                    ?.networkError ??
                                "Network error",
                            ),
                        );
                    };

                    xhr.send(file);
                },
            );

            const attachment:
                ComposerAttachment = {
                path: key,
                sizeBytes:
                file.size,
                messageId:
                newMessageId.current,
                filenameOriginal:
                file.name,
                contentType:
                    file.type ||
                    "application/octet-stream",
            };

            setAttachments(
                (current) => [
                    ...current,
                    attachment,
                ],
            );

            setUploads((current) =>
                current.map(
                    (upload) =>
                        upload.id ===
                        uploadId
                            ? {
                                ...upload,
                                progress: 100,
                                status: "done",
                                path: key,
                            }
                            : upload,
                ),
            );
        } catch (error) {
            setUploads((current) =>
                current.map(
                    (upload) =>
                        upload.id ===
                        uploadId
                            ? {
                                ...upload,
                                progress: 100,
                                status:
                                    "error",
                                error: String(
                                    error,
                                ),
                            }
                            : upload,
                ),
            );
        }
    };

    const handleFileSelect =
        async (
            event: React.ChangeEvent<HTMLInputElement>,
        ) => {
            const files = Array.from(
                event.target.files ??
                [],
            );

            for (const file of files) {
                await uploadFile(file);
            }

            event.target.value = "";
        };

    const handleDragEnter = (
        event: React.DragEvent<HTMLDivElement>,
    ) => {
        if (
            !event.dataTransfer.types.includes(
                "Files",
            )
        ) {
            return;
        }

        event.preventDefault();

        dragDepthRef.current += 1;
        setIsDraggingFiles(true);
    };

    const handleDragOver = (
        event: React.DragEvent<HTMLDivElement>,
    ) => {
        if (
            !event.dataTransfer.types.includes(
                "Files",
            )
        ) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect =
            "copy";
    };

    const handleDragLeave = (
        event: React.DragEvent<HTMLDivElement>,
    ) => {
        if (
            !event.dataTransfer.types.includes(
                "Files",
            )
        ) {
            return;
        }

        event.preventDefault();

        dragDepthRef.current =
            Math.max(
                0,
                dragDepthRef.current -
                1,
            );

        if (
            dragDepthRef.current === 0
        ) {
            setIsDraggingFiles(false);
        }
    };

    const handleDrop = async (
        event: React.DragEvent<HTMLDivElement>,
    ) => {
        if (
            !event.dataTransfer.types.includes(
                "Files",
            )
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        dragDepthRef.current = 0;
        setIsDraggingFiles(false);

        const files = Array.from(
            event.dataTransfer.files,
        );

        for (const file of files) {
            await uploadFile(file);
        }
    };

    const handleRemoveUpload = (
        uploadId: string,
    ) => {
        const upload = uploads.find(
            (item) =>
                item.id === uploadId,
        );

        setUploads((current) =>
            current.filter(
                (item) =>
                    item.id !== uploadId,
            ),
        );

        if (upload?.path) {
            setAttachments(
                (current) =>
                    current.filter(
                        (
                            attachment,
                        ) =>
                            attachment.path !==
                            upload.path,
                    ),
            );
        }
    };

    const handleOpenAttachment =
        async (
            upload: ComposerUpload,
        ) => {
            if (!upload.path) {
                return;
            }

            try {
                const { url } =
                    await createAttachmentDownloadUrl(
                        upload.path,
                    );

                window.open(
                    url,
                    "_blank",
                    "noopener,noreferrer",
                );
            } catch {
                toast.error(
                    dict?.mailbox.attachmentOpenFailed ??
                        "Could not open the attachment.",
                );
            }
        };

    const submittedSignaturePublicId =
        signatures.some(
            (signature) =>
                signature.publicId ===
                signaturePublicId,
        )
            ? signaturePublicId
            : "";

    const selectedSignature = useMemo(
        () =>
            signatures.find(
                (signature) =>
                    signature.publicId ===
                    submittedSignaturePublicId,
            ) ?? null,
        [
            signatures,
            submittedSignaturePublicId,
        ],
    );

    const signaturePreviewHtml = useMemo(
        () =>
            selectedSignature
                ? renderEmailFragment(
                    selectedSignature.document,
                )
                : "",
        [selectedSignature],
    );

    // ---- Reply/forward: restore the draft or load forwarded attachments ----
    // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened composer (it is keyed by message and mode)
    useEffect(() => {
        if (!message || initialDraft) {
            return;
        }

        let cancelled = false;
        const draftMode =
            initialMode === "forward"
                ? "forward"
                : "reply";

        const load = async () => {
            const draft =
                await fetchDraftForMessage(
                    message.id,
                    draftMode,
                ).catch(() => null);

            if (cancelled) return;

            if (draft) {
                const payload =
                    draft.payload;
                const restored =
                    parseDraftAttachments(
                        payload.attachments,
                    );

                draftIdRef.current =
                    draft.id;
                setDraftId(draft.id);
                lastSavedRef.current =
                    JSON.stringify(payload);
                setRestoredDraft({
                    id: draft.id,
                    payload,
                });
                setSubject(
                    payload.subject ?? "",
                );
                setAttachments(restored);
                setUploads(
                    uploadsFromAttachments(
                        restored,
                    ),
                );

                if (
                    payload.identityPublicId &&
                    identityMailboxes.some(
                        (item) =>
                            item.identity
                                .publicId ===
                            payload.identityPublicId,
                    )
                ) {
                    draftIdentityRef.current =
                        true;
                    setIdentityPublicId(
                        payload.identityPublicId,
                    );
                }

                draftSignatureRef.current =
                    payload.signaturePublicId ??
                    "";
                setSignaturePublicId(
                    payload.signaturePublicId ??
                    "",
                );

                toast.info(
                    dict?.mailbox
                        ?.draftRestored ??
                    "Restored your draft",
                    {
                        position:
                            "bottom-left",
                    },
                );
            } else if (
                draftMode === "forward"
            ) {
                const originals =
                    await fetchForwardableAttachments(
                        message.id,
                    ).catch(() => []);

                if (cancelled) return;

                const forwarded =
                    originals.map(
                        (
                            item,
                        ): ComposerAttachment => ({
                            path: item.path,
                            sizeBytes:
                            item.sizeBytes,
                            messageId:
                            message.id,
                            filenameOriginal:
                            item.filenameOriginal,
                            contentType:
                            item.contentType,
                            forwarded: true,
                        }),
                    );

                setAttachments(
                    (current) => [
                        ...forwarded,
                        ...current,
                    ],
                );
                setUploads((current) => [
                    ...uploadsFromAttachments(
                        forwarded,
                    ),
                    ...current,
                ]);
            }

            setDraftReady(true);
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, []);

    // Body of a restored draft, once the editor exists.
    const appliedDraftIdRef = useRef<
        string | null
    >(null);

    useEffect(() => {
        if (
            !editor ||
            !restoredDraft ||
            appliedDraftIdRef.current ===
            restoredDraft.id
        ) {
            return;
        }

        appliedDraftIdRef.current =
            restoredDraft.id;

        editor.commands.setContent(
            restoredDraft.payload
                .bodyHtml || "",
            { emitUpdate: false },
        );

        setHtml(
            editor.isEmpty
                ? ""
                : toEmailHtml(
                    editor.getHTML(),
                ),
        );
        setText(
            editor
                .getText({
                    blockSeparator: "\n",
                })
                .trim(),
        );
    }, [editor, restoredDraft]);

    // ---- Autosave --------------------------------------------------------
    // Persists the latest snapshot; only reads refs, so a stale closure (the
    // debounce timer, the unmount flush) is fine.
    const persistDraft = (): boolean => {
        const snap = snapshotRef.current;
        if (!snap || sendingRef.current) {
            return false;
        }

        const json = JSON.stringify(
            snap.payload,
        );

        if (json === lastSavedRef.current) {
            return false;
        }

        if (
            !draftIdRef.current &&
            contentKey(snap.payload) ===
            baselineRef.current
        ) {
            return false;
        }

        lastSavedRef.current = json;
        savedSomethingRef.current = true;

        // Serialized, so a slow first save cannot create two rows.
        saveChainRef.current =
            saveChainRef.current.then(
                async () => {
                    if (sendingRef.current) {
                        return;
                    }

                    const result =
                        await saveDraft({
                            draftId:
                            draftIdRef.current,
                            identityPublicId:
                            snap.identityPublicId,
                            payload:
                            snap.payload,
                        }).catch(() => null);

                    if (!result) {
                        // Retry with the next change.
                        lastSavedRef.current = "";
                        return;
                    }

                    if (
                        result.draftId &&
                        !sendingRef.current
                    ) {
                        draftIdRef.current =
                            result.draftId;
                        setDraftId(
                            result.draftId,
                        );
                    } else if (
                        result.draftId &&
                        sendingRef.current &&
                        !draftIdRef.current
                    ) {
                        // Created while sending/discarding: removed by
                        // the send/discard follow-up.
                        draftIdRef.current =
                            result.draftId;
                    }
                },
            );

        return true;
    };

    // persistDraft only reads refs; html and recipientsVersion re-trigger the
    // snapshot (the body and the uncontrolled recipient inputs).
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    useEffect(() => {
        const form = formRef.current;

        if (
            !draftReady ||
            !editor ||
            !form ||
            sendingRef.current
        ) {
            return;
        }

        const fields = new FormData(form);
        const get = (key: string) =>
            String(fields.get(key) ?? "");

        const payload: DraftPayload = {
            mode,
            identityPublicId,
            to: get("to"),
            cc: get("cc"),
            bcc: get("bcc"),
            subject,
            bodyHtml: editor.isEmpty
                ? ""
                : editor.getHTML(),
            text: editor
                .getText({
                    blockSeparator: "\n",
                })
                .trim(),
            attachments:
                JSON.stringify(attachments),
            signaturePublicId,
            originalMessageId:
                message?.id ?? undefined,
            threadUrl: message
                ? window.location.pathname
                : undefined,
        };

        if (baselineRef.current === null) {
            baselineRef.current =
                contentKey(payload);

            // A restored draft is saved again only once it changes.
            if (draftIdRef.current) {
                lastSavedRef.current =
                    JSON.stringify(payload);
            }
        }

        snapshotRef.current = {
            payload,
            identityPublicId,
        };

        if (saveTimerRef.current) {
            clearTimeout(
                saveTimerRef.current,
            );
        }

        saveTimerRef.current = setTimeout(
            persistDraft,
            AUTOSAVE_DELAY_MS,
        );
    }, [
        draftReady,
        editor,
        mode,
        identityPublicId,
        subject,
        html,
        text,
        attachments,
        signaturePublicId,
        recipientsVersion,
        message,
    ]);

    // Closing (X, Escape, navigating away) keeps the draft: flush it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only; persistDraft only reads refs
    useEffect(() => {
        const interval = setInterval(
            persistDraft,
            10_000,
        );

        return () => {
            clearInterval(interval);

            if (saveTimerRef.current) {
                clearTimeout(
                    saveTimerRef.current,
                );
            }

            if (sendingRef.current) {
                return;
            }

            persistDraft();

            if (savedSomethingRef.current) {
                toast.info(
                    dict?.mailbox
                        ?.draftSaved ??
                    "Draft saved",
                    {
                        position:
                            "bottom-left",
                    },
                );

                // Drafts list and sidebar count.
                void saveChainRef.current.then(
                    () =>
                        routerRef.current.refresh(),
                );
            }
        };
    }, []);

    const handleDiscard = async () => {
        sendingRef.current = true;

        if (saveTimerRef.current) {
            clearTimeout(
                saveTimerRef.current,
            );
        }

        setDiscarding(true);

        try {
            await saveChainRef.current;

            const id = draftIdRef.current;

            if (id) {
                await deleteDraft(id);
            }

            draftIdRef.current = null;

            toast.success(
                dict?.mailbox
                    ?.draftDiscarded ??
                "Draft discarded",
                {
                    position: "bottom-left",
                },
            );

            if (id) {
                routerRef.current.refresh();
            }

            onCloseRef.current?.();
        } catch (error) {
            sendingRef.current = false;
            setDiscarding(false);

            toast.error(
                dict?.common?.error ??
                "Error",
                {
                    description:
                        error instanceof Error
                            ? error.message
                            : undefined,
                },
            );
        }
    };

    // Escape in the body or subject closes the composer (the draft is kept).
    const handleKeyDown = (
        event: React.KeyboardEvent<HTMLFormElement>,
    ) => {
        if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            !onClose
        ) {
            return;
        }

        const target =
            event.target as HTMLElement | null;

        if (
            !target?.closest?.(
                ".ProseMirror, input[name='subject']",
            )
        ) {
            return;
        }

        event.preventDefault();
        onClose();
    };

    return (
        <div
            className="relative"
            onDragEnter={
                handleDragEnter
            }
            onDragOver={handleDragOver}
            onDragLeave={
                handleDragLeave
            }
            onDrop={handleDrop}
        >
            <Form
                action={formAction}
                ref={formRef}
                onKeyDown={handleKeyDown}
                onSubmitCapture={() => {
                    // No autosave while sending; resumes on error.
                    sendingRef.current = true;

                    if (saveTimerRef.current) {
                        clearTimeout(
                            saveTimerRef.current,
                        );
                    }
                }}
            >
                <input
                    type="hidden"
                    name="draftId"
                    value={draftId ?? ""}
                />

                <RichTextEditor
                    editor={editor}
                    className="!overflow-hidden !rounded-none !border-0"
                >
                    <MailComposerHeader
                        key={
                            restoredDraft?.id ??
                            "new"
                        }
                        initialRecipients={
                            restoredDraft
                                ? {
                                    to: splitAddresses(
                                        restoredDraft
                                            .payload.to,
                                    ),
                                    cc: splitAddresses(
                                        restoredDraft
                                            .payload.cc,
                                    ),
                                    bcc: splitAddresses(
                                        restoredDraft
                                            .payload.bcc,
                                    ),
                                }
                                : null
                        }
                        onRecipientsChange={
                            bumpRecipientsVersion
                        }
                        mode={mode}
                        subject={subject}
                        identityPublicId={
                            identityPublicId
                        }
                        identityMailboxes={
                            identityMailboxes
                        }
                        message={message}
                        onModeChange={
                            setMode
                        }
                        onSubjectChange={
                            setSubject
                        }
                        onIdentityChange={
                            setIdentityPublicId
                        }
                    />

                    <AiDraftPanel
                        mode={mode}
                        originalMessageId={message?.id ?? null}
                        getCurrentHtml={() => editor?.getHTML() ?? ""}
                        getCurrentText={() => editor?.getText().trim() ?? ""}
                        onInsert={(nextHtml) => {
                            editor
                                ?.chain()
                                .setContent(nextHtml, { emitUpdate: true })
                                .focus("end")
                                .run();
                        }}
                    />

                    <MailComposerBody
                        signatureHtml={
                            signaturePreviewHtml
                        }
                    />

                    <MailComposerFooter
                        editor={editor}
                        isPending={
                            isPending
                        }
                        uploads={uploads}
                        signatures={
                            signatures
                        }
                        signaturePublicId={
                            submittedSignaturePublicId
                        }
                        signaturesLoading={
                            signaturesLoading
                        }
                        onSignatureChange={
                            setSignaturePublicId
                        }
                        onAttach={() =>
                            fileInputRef.current?.click()
                        }
                        onRemoveUpload={
                            handleRemoveUpload
                        }
                        onOpenUpload={
                            handleOpenAttachment
                        }
                        onDiscard={
                            handleDiscard
                        }
                        discarding={
                            discarding
                        }
                    />
                </RichTextEditor>

                <input
                    type="hidden"
                    name="html"
                    value={html}
                />

                <input
                    type="hidden"
                    name="text"
                    value={text}
                />

                <input
                    type="hidden"
                    name="signaturePublicId"
                    value={
                        submittedSignaturePublicId
                    }
                />

                <input
                    type="hidden"
                    name="newMessageId"
                    value={
                        newMessageId.current
                    }
                />

                <input
                    type="hidden"
                    name="attachments"
                    value={JSON.stringify(
                        attachments,
                    )}
                />

                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={
                        handleFileSelect
                    }
                />

                {message && (
                    <input
                        type="hidden"
                        name="originalMessageId"
                        value={message.id}
                    />
                )}
            </Form>

            {isDraggingFiles && (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary bg-background/85 backdrop-blur-[1px]">
                    <div className="rounded-lg bg-background px-5 py-3 text-sm font-medium shadow-sm">
                        {dict?.mailbox
                                ?.dropFilesToAttach ??
                            "Drop files to attach"}
                    </div>
                </div>
            )}
        </div>
    );
}
