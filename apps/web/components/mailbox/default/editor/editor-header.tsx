import { getMessageAddress } from "@common/mail-client";
import type { MessageEntity } from "@db";
import {
	ActionIcon,
	FocusTrap,
	Group,
	Input,
	Select,
	type SelectProps,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Forward, Reply } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { InitialDraft } from "@/components/mailbox/default/editor/email-editor";
import EmailHeaderContacts from "@/components/mailbox/default/editor/email-header-contacts";
import { useDynamicContext } from "@/hooks/use-dynamic-context";

function splitList(value?: string) {
	return (value ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

function EditorHeader({ focusOnSubject }: { focusOnSubject?: () => void }) {
	const { state, setState } = useDynamicContext<{
		isPending: boolean;
		message: MessageEntity;
		showEditorMode: "reply" | "forward" | "compose";
		initialDraft?: InitialDraft;
		currentMode?: "reply" | "forward" | "compose";
	}>();

	// A restored draft brings its own mode, recipients and subject.
	const draft = state.initialDraft?.payload;
	const [initialMode] = useState<"reply" | "forward" | "compose">(() =>
		state.message && (draft?.mode === "reply" || draft?.mode === "forward")
			? draft.mode
			: state.showEditorMode,
	);
	const [mode, setMode] = useState<"reply" | "forward" | "compose">(
		initialMode,
	);
	const useDraftValues = !!draft && mode === initialMode;
	const [ccActive, setCcActive] = useState(!!draft?.cc);
	const [bccActive, setBccActive] = useState(!!draft?.bcc);

	// The footer needs the current mode (e.g. to offer forwarding attachments).
	useEffect(() => {
		setState((prev) => ({ ...prev, currentMode: mode }));
	}, [mode, setState]);

	const options = useMemo(
		() => [
			{ value: "reply", label: "Reply", Icon: Reply },
			{ value: "forward", label: "Forward", Icon: Forward },
		],
		[],
	);

	// Replies go to Reply-To when the sender set one; forwards start empty.
	const toEmail = useMemo(() => {
		if (!state?.message || mode === "forward") return "";
		const replyTo = (state.message as any).replyTo;
		const replyToAddress =
			typeof replyTo === "string"
				? replyTo
				: (replyTo?.value?.[0]?.address ?? null);
		return replyToAddress || getMessageAddress(state.message, "from") || "";
	}, [state.message, mode]);

	const renderOption: SelectProps["renderOption"] = ({ option }) => {
		const ItemIcon =
			options.find((o) => o.value === option.value)?.Icon ?? Reply;
		return (
			<Group gap="xs">
				<ItemIcon size={16} />
				<Text size={"sm"}>{option.label}</Text>
			</Group>
		);
	};

	const CurrentIcon = (options.find((o) => o.value === mode)?.Icon ??
		Reply) as typeof Reply;

	const computedSubject = useMemo(() => {
		if (!state.message) return "";

		const original = state.message.subject?.trim() || "";

		// Strip any chain of reply/forward prefixes ("Re: AW: Fwd: ...").
		const cleaned = original.replace(/^((re|aw|fwd?|wg)\s*:\s*)+/i, "");

		if (mode === "reply") return `Re: ${cleaned}`;
		if (mode === "forward") return `Fwd: ${cleaned}`;
		return cleaned;
	}, [state.message, mode]);

	const [subject, setSubject] = useState(draft?.subject ?? computedSubject);

	const initialComputedSubject = useRef(computedSubject);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only react to mode/subject changes, the draft is fixed per editor
	useEffect(() => {
		// Keep the draft's subject until the user switches the mode.
		if (draft && computedSubject === initialComputedSubject.current) return;
		setSubject(computedSubject);
	}, [computedSubject]);

	const isMobile = useMediaQuery("(max-width: 768px)");

	const [subjectFocus, setSubjectFocus] = useState<boolean>(false);

	return isMobile ? (
		<>
			<div
				className="border-b px-3 py-2 grid gap-3
                  grid-cols-1
                  sm:grid-cols-[auto,1fr,auto] sm:items-start"
			>
				{state.message ? (
					<div className="sm:pt-1">
						<Select
							value={mode}
							name="mode"
							onChange={(v) => v && setMode(v as "reply" | "forward")}
							data={options}
							renderOption={renderOption}
							leftSection={<CurrentIcon size={14} />}
							leftSectionPointerEvents="none"
							variant="unstyled"
							className="text-sm"
							comboboxProps={{
								withinPortal: true,
								position: "bottom",
								offset: 8,
								zIndex: 2000,
							}}
						/>
					</div>
				) : (
					<input type="hidden" name="mode" value={mode} />
				)}

				<div className="grid items-center gap-2 sm:grid-cols-[40px,1fr]">
					<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
						To
					</span>
					<EmailHeaderContacts
						key={`to-${mode}`}
						name={"to"}
						toEmail={toEmail}
						defaultValues={useDraftValues ? splitList(draft?.to) : undefined}
					/>
				</div>

				<div className="flex items-center justify-end gap-4 text-primary text-sm">
					{!ccActive && (
						<button
							type="button"
							onClick={() => setCcActive(true)}
							className="hover:underline"
							aria-label="Add Cc"
							title="Add Cc"
						>
							Cc
						</button>
					)}
					{!bccActive && (
						<button
							type="button"
							onClick={() => setBccActive(true)}
							className="hover:underline"
							aria-label="Add Bcc"
							title="Add Bcc"
						>
							Bcc
						</button>
					)}
				</div>
			</div>

			{ccActive && (
				<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
					<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
						Cc
					</span>
					<EmailHeaderContacts
						name={"cc"}
						defaultValues={useDraftValues ? splitList(draft?.cc) : undefined}
					/>
				</div>
			)}

			{bccActive && (
				<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
					<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
						Bcc
					</span>
					<EmailHeaderContacts
						name={"bcc"}
						defaultValues={useDraftValues ? splitList(draft?.bcc) : undefined}
					/>
				</div>
			)}

			<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
				<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
					Subject
				</span>
				<Input
					variant="unstyled"
					className="w-full text-base"
					name="subject"
					value={subject}
					onChange={(e) => setSubject(e.currentTarget.value)}
				/>
			</div>
		</>
	) : (
		<>
			<div className="border-b p-2 flex gap-2">
				{state.message ? (
					<div className="flex-shrink-0">
						<Select
							value={mode}
							name={"mode"}
							onChange={(v) => v && setMode(v as "reply" | "forward")}
							data={options}
							renderOption={renderOption}
							leftSection={<CurrentIcon size={16} />}
							leftSectionPointerEvents="none"
							variant="unstyled"
							w={130}
							comboboxProps={{
								withinPortal: true,
								position: "bottom",
								offset: 12,
								zIndex: 2000,
							}}
						/>
					</div>
				) : (
					<input type={"hidden"} name={"mode"} value={mode} />
				)}

				<div className="flex-grow flex justify-between">
					<div className="flex gap- items-stretch flex-col justify-start">
						<div className="flex items-center gap-2">
							<span className="text-sm text-muted-foreground">To</span>
							<EmailHeaderContacts
								key={`to-${mode}`}
								name={"to"}
								toEmail={toEmail}
								defaultValues={
									useDraftValues ? splitList(draft?.to) : undefined
								}
							/>
						</div>

						{ccActive && (
							<div className="flex items-center gap-2">
								<span className="text-sm text-muted-foreground">Cc</span>
								<EmailHeaderContacts
									name={"cc"}
									defaultValues={
										useDraftValues ? splitList(draft?.cc) : undefined
									}
								/>
							</div>
						)}

						{bccActive && (
							<div className="flex items-center gap-2">
								<span className="text-sm text-muted-foreground">Bcc</span>
								<EmailHeaderContacts
									name={"bcc"}
									defaultValues={
										useDraftValues ? splitList(draft?.bcc) : undefined
									}
								/>
							</div>
						)}
					</div>

					<div className="flex gap-2 items-center text-sm text-neutral-500">
						{!ccActive && (
							<ActionIcon
								onClick={() => setCcActive(true)}
								variant="transparent"
							>
								Cc
							</ActionIcon>
						)}
						{!bccActive && (
							<ActionIcon
								onClick={() => setBccActive(true)}
								variant="transparent"
							>
								Bcc
							</ActionIcon>
						)}
					</div>
				</div>
			</div>
			<div className={"border-b flex justify-start items-center px-2 gap-2"}>
				<span className="text-sm text-muted-foreground">Subject</span>
				<FocusTrap active={subjectFocus}>
					<Input
						variant={"unstyled"}
						className={"w-full"}
						name={"subject"}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								setSubjectFocus(false);
								focusOnSubject && focusOnSubject();
							}
						}}
						value={subject}
						onChange={(e) => setSubject(e.currentTarget.value)}
					/>
				</FocusTrap>
			</div>
		</>
	);
}

export default EditorHeader;
