"use client";

import { Minus, PencilLine, PenLine, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import * as React from "react";
import { useOptionalDictionary } from "@/components/providers/dictionary-provider";
import { Button } from "@/components/ui/button";
import type MailComposerComponent from "./mail-composer";

// The composer (TipTap, Mantine RTE, signature rendering) is only needed once
// the user opens it: keep it out of every mail page's initial bundle.
const MailComposer = dynamic(() => import("./mail-composer"), {
    ssr: false,
    loading: () => <ComposerLoading />,
});

function ComposerLoading() {
    const dict = useOptionalDictionary();
    return (
        <div className="p-4 text-sm text-muted-foreground">
            {dict?.common?.loading ?? "Loading…"}
        </div>
    );
}

type MailComposerProps = React.ComponentProps<typeof MailComposerComponent>;

type MailComposerLauncherProps = Pick<
    MailComposerProps,
    "publicConfig" | "identityMailboxes"
> & {
    /** Icon-only trigger (mobile list header). */
    compact?: boolean;
};

export default function MailComposerLauncher({
                                                 publicConfig,
                                                 identityMailboxes,
                                                 compact = false,
                                             }: MailComposerLauncherProps) {
    const params = useParams();
    const dict = useOptionalDictionary();

    const [open, setOpen] = React.useState(false);
    const [minimized, setMinimized] = React.useState(false);

    const activeIdentityPublicId = React.useMemo(() => {
        const paramValues = Object.values(params).flatMap((value) =>
            Array.isArray(value) ? value : value ? [value] : [],
        );

        return identityMailboxes.find((item) =>
            paramValues.includes(item.identity.publicId),
        )?.identity.publicId;
    }, [params, identityMailboxes]);

    const handleOpen = () => {
        setOpen(true);
        setMinimized(false);
    };

    const handleClose = React.useCallback(() => {
        setOpen(false);
        setMinimized(false);
    }, []);

    const handleMinimize = () => {
        setMinimized(true);
    };

    const handleRestore = () => {
        setMinimized(false);
    };

    const composeLabel = dict?.mailbox?.compose ?? "Compose";

    return (
        <>
            {compact ? (
                <Button
                    type="button"
                    size="icon"
                    className="size-8"
                    onClick={handleOpen}
                    aria-label={composeLabel}
                    title={composeLabel}
                >
                    <PencilLine />
                </Button>
            ) : (
                <Button
                    type="button"
                    onClick={handleOpen}
                    className="w-full justify-start gap-2"
                >
                    <PenLine size={16} />
                    {composeLabel}
                </Button>
            )}

            {open && (
                <div
                    className={[
                        "fixed z-[1000] overflow-hidden border bg-background shadow-xl",
                        "bottom-0 right-0 w-full",
                        "sm:bottom-4 sm:right-8 sm:w-[560px] sm:rounded-lg",
                        minimized
                            ? "h-auto sm:w-[320px]"
                            : "h-full overflow-y-auto sm:h-auto sm:max-h-[calc(100svh-2rem)]",
                    ].join(" ")}
                >
                    <div className="flex h-11 items-center justify-between border-b bg-muted/40 px-3">
                        {minimized ? (
                            <button
                                type="button"
                                className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                                onClick={handleRestore}
                            >
                                {dict?.mailbox?.newMessage ?? "New message"}
                            </button>
                        ) : (
                            <div className="text-sm font-medium">
                                {dict?.mailbox?.newMessage ?? "New message"}
                            </div>
                        )}

                        <div className="flex items-center gap-1">
                            {minimized ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={handleRestore}
                                    aria-label={dict?.mailbox?.restore ?? "Restore"}
                                >
                                    <PenLine size={16} />
                                </Button>
                            ) : (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={handleMinimize}
                                    aria-label={dict?.mailbox?.minimize ?? "Minimize"}
                                >
                                    <Minus size={16} />
                                </Button>
                            )}

                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={handleClose}
                                aria-label={dict?.mailbox?.close ?? "Close"}
                            >
                                <X size={16} />
                            </Button>
                        </div>
                    </div>

                    <div className={minimized ? "hidden" : "block"}>
                        <MailComposer
                            publicConfig={publicConfig}
                            identityMailboxes={identityMailboxes}
                            activeIdentityPublicId={activeIdentityPublicId}
                            message={null}
                            onClose={handleClose}
                        />
                    </div>
                </div>
            )}
        </>
    );
}
