"use client";
import React, { useEffect, useRef, useState } from "react";
import {
	ComboboxItem,
	TagsInput,
	TagsInputProps,
	OptionsFilter,
} from "@mantine/core";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { searchContactsForCompose } from "@/lib/actions/calendar";

export default function EmailHeaderContacts({
	name,
	toEmail,
	maxTags,
	onChange,
}: {
	toEmail?: string;
	maxTags?: number;
	onChange?: (value: string[]) => void;
	name: string;
}) {
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestIdRef = useRef(0);

	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	// Debounce the server lookup and drop out-of-order responses so fast
	// typing neither floods the server nor shows stale suggestions.
	const searchContacts = (val: string) => {
		setSearchValue(val);
		if (debounceRef.current) clearTimeout(debounceRef.current);
		if (!val.trim()) {
			setOptions([]);
			return;
		}
		debounceRef.current = setTimeout(async () => {
			const requestId = ++requestIdRef.current;
			try {
				const rows = await searchContactsForCompose(val);
				if (requestId !== requestIdRef.current) return;
				setOptions(
					rows.map((row) => ({
						value: row.email,
						label: `${row.name} <${row.email}>`,
						avatar: row.avatar,
					})),
				);
			} catch {
				if (requestId === requestIdRef.current) setOptions([]);
			}
		}, 200);
	};

	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<ContactSuggestionItem option={option} />
	);

	const filter: OptionsFilter = ({ options, search }) => {
		const s = search.toLowerCase();
		return (options as ComboboxItem[]).filter((opt) =>
			opt.label.toLowerCase().includes(s),
		);
	};

	return (
		<>
			<TagsInput
				autoFocus={name === "to" && !toEmail}
				defaultValue={toEmail ? [toEmail] : []}
				searchValue={searchValue}
				onSearchChange={searchContacts}
				data={options}
				onChange={(value) => {
					if (value.length > 0) {
						onChange && onChange(value as string[]);
					}
				}}
				renderOption={renderOption}
				filter={filter}
				maxTags={maxTags}
				name={name}
				size="sm"
				variant="unstyled"
				className="min-h-[28px] text-sm w-full sm:w-96"
				comboboxProps={{
					dropdownPadding: 0,
					withinPortal: false,
					position: "bottom-start",
					offset: 1,
					width: "target",
					shadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
					transitionProps: { transition: "skew-down", duration: 150 },
				}}
			/>
		</>
	);
}
