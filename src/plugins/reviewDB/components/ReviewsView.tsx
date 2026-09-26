/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Auth, authorize } from "@plugins/reviewDB/auth";
import { Ratings, Review, ReviewType } from "@plugins/reviewDB/entities";
import { addReview, getReviews, REVIEWS_PER_PAGE, UserReviewsData } from "@plugins/reviewDB/reviewDbApi";
import { settings } from "@plugins/reviewDB/settings";
import { cl, showToast } from "@plugins/reviewDB/utils";
import { useAwaiter, useForceUpdater } from "@utils/react";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { Forms, React, RelationshipStore, useRef, useState, UserStore } from "@webpack/common";

import ReviewComponent from "./ReviewComponent";

const Transforms = findByPropsLazy("insertNodes", "textToText");
const Editor = findByPropsLazy("start", "end", "toSlateRange");
const ChatInputTypes = findByPropsLazy("FORM", "USER_PROFILE");
const InputComponent = findComponentByCodeLazy("editorClassName", "CHANNEL_TEXT_AREA");
const createChannelRecordFromServer = findByCodeLazy(".GUILD_TEXT]", "fromServer)");

const USER_RATING_CATEGORIES = ["trustworthy", "friendly", "skilled"] as const;
const SERVER_RATING_CATEGORIES = ["friendly", "active", "moderated"] as const;

function RatingsPicker({ categories, ratings, onChange }: { categories: readonly string[]; ratings: Ratings; onChange(ratings: Ratings): void; }) {
    return (
        <div className={cl("ratings-picker")}>
            {categories.map(category => (
                <div key={category} className={cl("ratings-row")}>
                    <span className={cl("ratings-label")}>{category[0].toUpperCase() + category.slice(1)}</span>
                    <div className={cl("ratings-stars")}>
                        {[1, 2, 3, 4, 5].map(value => (
                            <button
                                key={value}
                                type="button"
                                className={cl("ratings-star", (ratings[category] ?? 0) >= value && "ratings-star-filled")}
                                onClick={() => {
                                    // clicking the current value clears that category
                                    const next = { ...ratings };
                                    if (ratings[category] === value) delete next[category];
                                    else next[category] = value;
                                    onChange(next);
                                }}
                            >
                                ★
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function RatingsSummaryBar({ summary, categories }: { summary?: Record<string, { average: number; count: number }>; categories?: readonly string[]; }) {
    if (!summary) return null;
    const entries = Object.entries(summary);
    if (entries.length === 0) return null;

    return (
        <div className={cl("ratings-summary")}>
            {entries.map(([category, { average, count }]) => (
                <div key={category} className={cl("ratings-summary-item")} title={`${count} rating${count === 1 ? "" : "s"}`}>
                    <span className={cl("ratings-label")}>{category[0].toUpperCase() + category.slice(1)}</span>
                    <span className={cl("ratings-summary-average")}>{average.toFixed(1)}</span>
                    <span className={cl("ratings-summary-stars")}>
                        {[1, 2, 3, 4, 5].map(value => (
                            <span
                                key={value}
                                className={cl("ratings-star", average >= value - 0.25 && "ratings-star-filled")}
                            >★</span>
                        ))}
                    </span>
                </div>
            ))}
            {categories && <span className={cl("ratings-summary-cats")}>{categories.join(" · ")}</span>}
        </div>
    );
}

interface UserProps {
    discordId: string;
    name: string;
}

interface Props extends UserProps {
    onFetchReviews(data: UserReviewsData): void;
    refetchSignal?: unknown;
    showInput?: boolean;
    page?: number;
    scrollToTop?(): void;
    hideOwnReview?: boolean;
    type: ReviewType;
}

export default function ReviewsView({
    discordId,
    name,
    onFetchReviews,
    refetchSignal,
    scrollToTop,
    page = 1,
    showInput = false,
    hideOwnReview = false,
    type,
}: Props) {
    const [signal, refetch] = useForceUpdater(true);

    const [reviewData] = useAwaiter(() => getReviews(discordId, { offset: (page - 1) * REVIEWS_PER_PAGE, limit: REVIEWS_PER_PAGE, fetchVotes: true, type }), {
        fallbackValue: null,
        deps: [refetchSignal, signal, page],
        onSuccess: data => {
            if (settings.store.hideBlockedUsers) data!.reviews = data!.reviews?.filter(r => !RelationshipStore.isBlocked(r.sender.discordID));
            const systemReviews = data!.reviews.filter(r => r.type === ReviewType.System);
            const normalReviews = data!.reviews.filter(r => r.type !== ReviewType.System);

            data!.reviews = [...systemReviews, ...normalReviews];
            scrollToTop?.();
            onFetchReviews(data!);
        }
    });

    if (!reviewData) return null;

    return (
        <>
            <RatingsSummaryBar summary={reviewData.ratingsSummary} categories={reviewData.ratingCategories} />
            <ReviewList
                refetch={refetch}
                reviews={reviewData!.reviews}
                hideOwnReview={hideOwnReview}
                profileId={discordId}
                type={type}
            />

            {showInput && (
                <ReviewsInputComponent
                    name={name}
                    discordId={discordId}
                    refetch={refetch}
                    isAuthor={reviewData!.reviews?.some(r => r.sender.discordID === UserStore.getCurrentUser().id)}
                    type={type}
                />
            )}
        </>
    );
}

function ReviewList({ refetch, reviews, hideOwnReview, profileId, type }: { refetch(): void; reviews: Review[]; hideOwnReview: boolean; profileId: string; type: ReviewType; }) {
    const myId = UserStore.getCurrentUser().id;

    return (
        <div className={cl("view")}>
            {reviews?.map(review =>
                (review.sender.discordID !== myId || !hideOwnReview) &&
                <ReviewComponent
                    key={review.id}
                    review={review}
                    refetch={refetch}
                    profileId={profileId}
                />
            )}

            {reviews?.length === 0 && (
                <Forms.FormText className={cl("placeholder")}>
                    Looks like nobody reviewed this {type === ReviewType.User ? "user" : "server"} yet. You could be the first!
                </Forms.FormText>
            )}
        </div>
    );
}


export function ReviewsInputComponent(
    { discordId, isAuthor, refetch, name, modalKey, type = ReviewType.User }: { discordId: string, name: string; isAuthor: boolean; refetch(): void; modalKey?: string; type?: ReviewType; }
) {
    const { token } = Auth;
    const editorRef = useRef<any>(null);
    const [ratings, setRatings] = useState<Ratings>({});
    const [showRatings, setShowRatings] = useState(false);
    const inputType = ChatInputTypes.USER_PROFILE_REPLY;
    inputType.disableAutoFocus = true;

    const channel = createChannelRecordFromServer({ id: "0", type: 1 });

    return (
        <>
            <div className={cl("ratings-toggle")}>
                <button
                    type="button"
                    className={cl("ratings-toggle-button", showRatings && "ratings-toggle-open")}
                    onClick={() => setShowRatings(v => !v)}
                >
                    {showRatings ? "Hide ratings" : "Add ratings ★"}
                </button>
            </div>
            {showRatings && token && (
                <RatingsPicker
                    categories={type === ReviewType.Server ? SERVER_RATING_CATEGORIES : USER_RATING_CATEGORIES}
                    ratings={ratings}
                    onChange={setRatings}
                />
            )}
            <div onClick={() => {
                if (!token) {
                    showToast("Opening authorization window...");
                    authorize();
                }
            }}>
                <InputComponent
                    className={cl("input")}
                    channel={channel}
                    placeholder={
                        !token
                            ? "You need to authorize to review users!"
                            : isAuthor
                                ? `Update review for @${name}`
                                : `Review @${name}`
                    }
                    type={inputType}
                    disableThemedBackground={true}
                    setEditorRef={ref => editorRef.current = ref}
                    parentModalKey={modalKey}
                    textValue=""
                    onSubmit={
                        async res => {
                            const response = await addReview({
                                userid: discordId,
                                comment: res.value,
                                ratings: Object.keys(ratings).length ? ratings : undefined,
                                type,
                            });

                            if (response) {
                                setRatings({});
                                setShowRatings(false);
                                refetch();

                                const slateEditor = editorRef.current.ref.current.getSlateEditor();

                                // clear editor
                                Transforms.delete(slateEditor, {
                                    at: {
                                        anchor: Editor.start(slateEditor, []),
                                        focus: Editor.end(slateEditor, []),
                                    }
                                });
                            }

                            // even tho we need to return this, it doesnt do anything
                            return {
                                shouldClear: false,
                                shouldRefocus: true,
                            };
                        }
                    }
                />
            </div>

        </>
    );
}
