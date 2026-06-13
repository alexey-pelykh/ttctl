// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { availability } from "@ttctl/core";

import { formatAvailabilitySnapshot } from "../show.js";
import { formatWorkingHoursSet, formatWorkingHoursShow } from "../working-hours.js";

const TIME_ZONE_BERLIN: availability.AvailabilityTimeZone = {
  name: "Central European Time",
  value: "Europe/Berlin",
  location: "Berlin, Germany",
  utcOffset: 3600,
  stdOffset: 3600,
};

const SNAPSHOT_FIXTURE: availability.AvailabilitySnapshot = {
  viewerId: "viewer-1",
  timeZone: TIME_ZONE_BERLIN,
  workingTimeFrom: "09:00:00",
  workingTimeTo: "17:00:00",
  availableShiftRangeFrom: "07:00:00",
  availableShiftRangeTo: "19:00:00",
  allocatedHours: 40,
};

describe("formatAvailabilitySnapshot", () => {
  it("renders all sections when every field is populated", () => {
    const rendered = formatAvailabilitySnapshot(SNAPSHOT_FIXTURE);
    expect(rendered).toContain("Availability (viewer viewer-1)");
    expect(rendered).toContain("Time zone");
    expect(rendered).toContain("IANA: Europe/Berlin");
    expect(rendered).toContain("Working hours");
    expect(rendered).toContain("From: 09:00:00");
    expect(rendered).toContain("To:   17:00:00");
    expect(rendered).toContain("Flexible shift range");
    expect(rendered).toContain("Allocated hours");
    expect(rendered).toContain("40 h/week");
  });

  it("omits the time-zone section when timeZone is null", () => {
    const rendered = formatAvailabilitySnapshot({ ...SNAPSHOT_FIXTURE, timeZone: null });
    expect(rendered).not.toContain("Time zone");
    expect(rendered).toContain("Working hours");
  });

  it("omits the working-hours section when both workingTimeFrom and workingTimeTo are null", () => {
    const rendered = formatAvailabilitySnapshot({
      ...SNAPSHOT_FIXTURE,
      workingTimeFrom: null,
      workingTimeTo: null,
    });
    expect(rendered).not.toContain("Working hours");
  });

  it("renders working-hours section when only one bound is set", () => {
    const rendered = formatAvailabilitySnapshot({
      ...SNAPSHOT_FIXTURE,
      workingTimeFrom: "09:00:00",
      workingTimeTo: null,
    });
    expect(rendered).toContain("Working hours");
    expect(rendered).toContain("From: 09:00:00");
    expect(rendered).toContain("To:   —");
  });

  it("renders an (unset) line when allocatedHours is null", () => {
    const rendered = formatAvailabilitySnapshot({ ...SNAPSHOT_FIXTURE, allocatedHours: null });
    expect(rendered).toContain("Allocated hours");
    expect(rendered).toContain("(unset)");
  });

  it("hides the standard-offset line when it equals UTC offset", () => {
    const rendered = formatAvailabilitySnapshot(SNAPSHOT_FIXTURE);
    expect(rendered).not.toContain("Standard offset");
  });

  it("shows the standard-offset line when it differs from UTC offset", () => {
    const rendered = formatAvailabilitySnapshot({
      ...SNAPSHOT_FIXTURE,
      timeZone: { ...TIME_ZONE_BERLIN, utcOffset: 7200, stdOffset: 3600 },
    });
    expect(rendered).toContain("Standard offset: 3600");
  });
});

describe("formatWorkingHoursShow", () => {
  it("renders time zone + daily window + flexible range", () => {
    const rendered = formatWorkingHoursShow({
      viewerId: "viewer-1",
      timeZone: TIME_ZONE_BERLIN,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
    });
    expect(rendered).toContain("Working hours (viewer viewer-1)");
    expect(rendered).toContain("IANA: Europe/Berlin");
    expect(rendered).toContain("Daily window");
    expect(rendered).toContain("Flexible shift range");
  });

  it("omits flexible shift range when both bounds are null", () => {
    const rendered = formatWorkingHoursShow({
      viewerId: "viewer-1",
      timeZone: TIME_ZONE_BERLIN,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: null,
      availableShiftRangeTo: null,
    });
    expect(rendered).not.toContain("Flexible shift range");
  });
});

describe("formatWorkingHoursSet", () => {
  it("renders time-zone + working line, omits flex when null", () => {
    const rendered = formatWorkingHoursSet({
      timeZone: TIME_ZONE_BERLIN,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: null,
      availableShiftRangeTo: null,
      notice: null,
    });
    expect(rendered).toContain("Time zone: Europe/Berlin");
    expect(rendered).toContain("Working: 09:00:00 → 17:00:00");
    expect(rendered).not.toContain("Flex:");
  });

  it("renders the Flex line when at least one flex bound is set", () => {
    const rendered = formatWorkingHoursSet({
      timeZone: null,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
      notice: null,
    });
    expect(rendered).toContain("Flex:    07:00:00 → 19:00:00");
  });

  it("omits the Time zone line when timeZone is null", () => {
    const rendered = formatWorkingHoursSet({
      timeZone: null,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: null,
      availableShiftRangeTo: null,
      notice: null,
    });
    expect(rendered).not.toContain("Time zone:");
  });
});
