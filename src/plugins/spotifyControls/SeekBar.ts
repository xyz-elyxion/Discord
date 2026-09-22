/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LazyComponent } from "@utils/lazyReact";
import { Slider } from "@webpack/common";

export const SeekBar = LazyComponent(() => {
    const SliderClass = Slider.$$limeyV1GetWrappedComponent();

    // Discord's Slider does not update `state.value` when `props.initialValue` changes if state.value is not nullish.
    // We extend their class and override their `getDerivedStateFromProps` to update the value
    return class SeekBar extends SliderClass {
        static getDerivedStateFromProps(props: any, state: any) {
            const newState = super.getDerivedStateFromProps!(props, state);
            if (newState) {
                newState.value = props.initialValue;
            }

            return newState;
        }
    };
});
