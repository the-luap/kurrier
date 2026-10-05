"use client";

import { getDayjsTz } from "@common/day-js-extended";
import { Button, Divider, Modal } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { getTimeZones } from "@vvo/tzdb";
import type { Dayjs } from "dayjs";
import { CalendarClock } from "lucide-react";
import { useMemo, useState } from "react";
import { useOptionalI18n } from "@/components/providers/dictionary-provider";

// The snooze dialogs (timezone database, date picker, dayjs tz) are only
// needed once the user opens them: SnoozeMail loads this module lazily so
// the mailbox list does not ship / mount them for every row.
export default function SnoozeMailDialog({
	opened,
	saving,
	onCommit,
	onClose,
}: {
	opened: boolean;
	saving: boolean;
	onCommit: (next: Date) => void;
	onClose: () => void;
}) {
	const i18n = useOptionalI18n();
	const dict = i18n?.dict;
	const format = i18n?.format;

	const [step, setStep] = useState<"presets" | "picker">("presets");
	// Every (re)open starts at the presets with fresh preset times.
	const [openedAt, setOpenedAt] = useState(() => Date.now());
	const [wasOpened, setWasOpened] = useState(opened);
	if (opened !== wasOpened) {
		setWasOpened(opened);
		if (opened) {
			setStep("presets");
			setOpenedAt(Date.now());
		}
	}

	const localTz = useMemo(
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
		[],
	);
	const dayjsTz = useMemo(() => getDayjsTz(localTz), [localTz]);
	const tzName = useMemo(
		() => getTimeZones().find((tz) => tz.group.includes(localTz)),
		[localTz],
	);

	const presets = useMemo(() => {
		// Relative to the moment the dialog was (re)opened.
		const now = () => dayjsTz(openedAt);
		return [
			{
				label: dict?.mailbox?.laterToday ?? "Later today",
				date: now().add(2, "h"),
			},
			{
				label: dict?.mailbox?.tomorrowMorning ?? "Tomorrow morning",
				date: now().endOf("d").add(8, "h").add(1, "m"),
			},
			{
				label: dict?.mailbox?.tomorrowAfternoon ?? "Tomorrow afternoon",
				date: now().endOf("d").add(13, "h").add(1, "m"),
			},
			{
				label: dict?.mailbox?.mondayMorning ?? "Monday morning",
				date: now().endOf("w").add(8, "h").add(1, "m"),
			},
		];
	}, [dayjsTz, openedAt, dict]);

	const [pickerValue, setPickerValue] = useState<Dayjs>(() => dayjsTz());
	const pickerDateValue = useMemo(
		() => (pickerValue.isValid() ? pickerValue.toDate() : null),
		[pickerValue],
	);

	const is24h = format?.hourCycle() === "h23" || format?.hourCycle() === "h24";

	return (
		<>
			<Modal
				centered
				opened={opened && step === "picker"}
				onClose={onClose}
				title={
					<span className="text-xl">{dict?.mailbox?.snooze ?? "Snooze"}</span>
				}
				size="sm"
				zIndex={1003}
			>
				<DateTimePicker
					label={dict?.mailbox?.pickDateAndTime ?? "Pick date and time"}
					placeholder={dict?.mailbox?.pickDateAndTime ?? "Pick date and time"}
					value={pickerDateValue}
					onChange={(val) => {
						if (!val) return;
						const d = dayjsTz(val);
						if (d.isValid()) setPickerValue(d);
					}}
					valueFormat={is24h ? "DD.MM.YYYY HH:mm" : "DD MMM hh:mm A"}
					popoverProps={{ zIndex: 1004 }}
					className="my-4"
					timePickerProps={{
						withDropdown: true,
						popoverProps: { withinPortal: false },
						format: is24h ? "24h" : "12h",
					}}
					disabled={saving}
				/>

				<Button
					fullWidth
					loading={saving}
					onClick={() => {
						if (!pickerValue?.isValid?.()) return;
						onCommit(pickerValue.toDate());
					}}
				>
					{dict?.mailbox?.snooze ?? "Snooze"}
				</Button>
			</Modal>

			<Modal
				centered
				opened={opened && step === "presets"}
				closeOnClickOutside={false}
				onClose={onClose}
				title={
					<span className="text-xl">{dict?.mailbox?.snooze ?? "Snooze"}</span>
				}
				size="sm"
				zIndex={1001}
			>
				<div className="my-2 p-2 font-semibold">
					{tzName?.alternativeName} ({tzName?.abbreviation})
				</div>

				{presets.map((preset) => (
					<button
						key={preset.label}
						type="button"
						disabled={saving}
						className="w-full items-center px-2 text-left rounded hover:bg-gray-100 flex gap-4 justify-between dark:hover:bg-neutral-700 disabled:opacity-50"
						onClick={() => onCommit(preset.date.toDate())}
					>
						<span className="my-1">{preset.label}</span>
						<span>
							{format?.date(preset.date.toDate(), {
								dateStyle: "medium",
								timeStyle: "short",
							}) ?? preset.date.format("MMM DD, hh:mm A")}
						</span>
					</button>
				))}

				<Divider my="lg" variant="dashed" />

				<Button
					leftSection={<CalendarClock size={16} />}
					variant="light"
					fullWidth
					disabled={saving}
					onClick={() => setStep("picker")}
				>
					{dict?.mailbox?.pickDateAndTime ?? "Pick date and time"}
				</Button>
			</Modal>
		</>
	);
}
