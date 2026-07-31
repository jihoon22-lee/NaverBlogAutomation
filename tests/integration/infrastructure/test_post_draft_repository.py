"""SQLite behavior for post drafts."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy.engine import Engine

from naver_blog_assistant.domain.writing import (
    BlockKind,
    BodyBlock,
    DraftImage,
    DraftStatus,
    DraftTag,
    RevisionKind,
    TagSource,
)
from naver_blog_assistant.infrastructure.database.engine import create_sqlite_engine
from naver_blog_assistant.infrastructure.database.post_draft_repository import (
    DraftNotFoundError,
    SqlitePostDraftRepository,
)
from naver_blog_assistant.infrastructure.database.schema import metadata


@pytest.fixture
def repository(tmp_path: Path) -> Iterator[SqlitePostDraftRepository]:
    engine: Engine = create_sqlite_engine(f"sqlite:///{tmp_path / 'drafts.db'}")
    metadata.create_all(engine)
    yield SqlitePostDraftRepository(engine)
    engine.dispose()


def draft_id_for(repository: SqlitePostDraftRepository, **overrides: object) -> UUID:
    draft_id = uuid4()
    payload: dict[str, object] = {
        "draft_id": draft_id,
        "title": "합성 초안",
        "seed_text": "메모한 내용입니다.",
        "category_no": 7,
        "use_image_vision": False,
    }
    payload.update(overrides)
    repository.create(**payload)  # type: ignore[arg-type]
    return draft_id


def paragraph(text: str = "문단입니다.") -> BodyBlock:
    return BodyBlock(kind=BlockKind.PARAGRAPH, text=text)


def test_a_new_draft_starts_without_revisions(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)

    draft = repository.get(draft_id)

    assert draft.status is DraftStatus.COLLECTING
    assert draft.revisions == ()
    assert draft.next_round == 1
    assert draft.created_at is not None


def test_an_unknown_draft_is_reported(repository: SqlitePostDraftRepository) -> None:
    with pytest.raises(DraftNotFoundError):
        repository.get(uuid4())


def test_a_revision_round_trips_with_its_blocks(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)
    image_id = uuid4()
    repository.add_image(
        DraftImage(
            id=image_id,
            draft_id=draft_id,
            ordinal=0,
            stored_path=f"drafts/{draft_id}/{image_id}.png",
            original_filename="a.png",
            byte_size=100,
            mime="image/png",
        )
    )

    draft = repository.add_revision(
        draft_id=draft_id,
        revision_id=uuid4(),
        round_no=1,
        kind=RevisionKind.COMPOSED,
        title="생성된 제목",
        blocks=(paragraph(), BodyBlock(kind=BlockKind.IMAGE, image_id=image_id, caption="사진")),
        summary="요약",
        provider="openai",
        model="gpt-test",
        activate=True,
        status=DraftStatus.COMPOSED,
    )

    active = draft.active_revision
    assert active is not None
    assert active.provider == "openai"
    assert [block.kind for block in active.blocks] == [BlockKind.PARAGRAPH, BlockKind.IMAGE]
    assert active.blocks[1].image_id == image_id
    assert draft.status is DraftStatus.COMPOSED


def test_activating_one_revision_deactivates_the_others(
    repository: SqlitePostDraftRepository,
) -> None:
    draft_id = draft_id_for(repository)
    first_id, second_id = uuid4(), uuid4()
    for revision_id, round_no in ((first_id, 1), (second_id, 2)):
        repository.add_revision(
            draft_id=draft_id,
            revision_id=revision_id,
            round_no=round_no,
            kind=RevisionKind.COMPOSED,
            title=f"제목 {round_no}",
            blocks=(paragraph(),),
            activate=True,
        )

    draft = repository.activate_revision(draft_id, first_id)

    assert draft.active_revision is not None
    assert draft.active_revision.id == first_id
    assert sum(1 for revision in draft.revisions if revision.is_active) == 1


def test_activating_a_revision_of_another_draft_is_refused(
    repository: SqlitePostDraftRepository,
) -> None:
    first = draft_id_for(repository)
    second = draft_id_for(repository)
    revision_id = uuid4()
    repository.add_revision(
        draft_id=first,
        revision_id=revision_id,
        round_no=1,
        kind=RevisionKind.COMPOSED,
        title="제목",
        blocks=(paragraph(),),
    )

    with pytest.raises(DraftNotFoundError):
        repository.activate_revision(second, revision_id)


def test_a_revision_for_an_unknown_draft_is_refused(
    repository: SqlitePostDraftRepository,
) -> None:
    with pytest.raises(DraftNotFoundError):
        repository.add_revision(
            draft_id=uuid4(),
            revision_id=uuid4(),
            round_no=1,
            kind=RevisionKind.SEED,
            title="제목",
            blocks=(paragraph(),),
        )


def test_images_take_the_next_ordinal(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)

    for index in range(3):
        image_id = uuid4()
        repository.add_image(
            DraftImage(
                id=image_id,
                draft_id=draft_id,
                ordinal=repository.next_image_ordinal(draft_id),
                stored_path=f"drafts/{draft_id}/{image_id}.png",
                original_filename=f"{index}.png",
                byte_size=10,
                mime="image/png",
            )
        )

    assert [image.ordinal for image in repository.get(draft_id).images] == [0, 1, 2]
    assert repository.next_image_ordinal(draft_id) == 3


def test_removing_an_image_reports_its_path(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)
    image_id = uuid4()
    path = f"drafts/{draft_id}/{image_id}.png"
    repository.add_image(
        DraftImage(
            id=image_id,
            draft_id=draft_id,
            ordinal=0,
            stored_path=path,
            original_filename="a.png",
            byte_size=10,
            mime="image/png",
        )
    )

    draft, removed = repository.remove_image(draft_id, image_id)

    assert removed == path
    assert draft.images == ()
    with pytest.raises(DraftNotFoundError):
        repository.remove_image(draft_id, image_id)


def test_tags_are_replaced_as_a_whole(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)
    repository.replace_tags(
        draft_id,
        [DraftTag(tag="전시", ordinal=0), DraftTag(tag="기록", ordinal=1, selected=False)],
    )

    draft = repository.replace_tags(
        draft_id, [DraftTag(tag="요리", ordinal=0, source=TagSource.USER)]
    )

    assert [(tag.tag, tag.source, tag.selected) for tag in draft.tags] == [
        ("요리", TagSource.USER, True)
    ]


def test_updating_a_draft_changes_only_the_given_fields(
    repository: SqlitePostDraftRepository,
) -> None:
    draft_id = draft_id_for(repository)

    updated = repository.update_draft(draft_id, title="새 제목", status=DraftStatus.TAGGED)

    assert updated.title == "새 제목"
    assert updated.status is DraftStatus.TAGGED
    assert updated.category_no == 7
    assert updated.use_image_vision is False


def test_updating_an_unknown_draft_is_refused(repository: SqlitePostDraftRepository) -> None:
    with pytest.raises(DraftNotFoundError):
        repository.update_draft(uuid4(), title="제목")


def test_listing_returns_the_newest_first(repository: SqlitePostDraftRepository) -> None:
    first = draft_id_for(repository, title="첫 초안")
    second = draft_id_for(repository, title="두 번째 초안")

    listed = repository.list(limit=5)

    assert {draft.id for draft in listed} == {first, second}
    assert len(listed) == 2


def test_deleting_reports_the_image_paths(repository: SqlitePostDraftRepository) -> None:
    draft_id = draft_id_for(repository)
    image_id = uuid4()
    repository.add_image(
        DraftImage(
            id=image_id,
            draft_id=draft_id,
            ordinal=0,
            stored_path=f"drafts/{draft_id}/{image_id}.png",
            original_filename="a.png",
            byte_size=10,
            mime="image/png",
        )
    )
    repository.replace_tags(draft_id, [DraftTag(tag="전시", ordinal=0)])
    repository.add_revision(
        draft_id=draft_id,
        revision_id=uuid4(),
        round_no=1,
        kind=RevisionKind.SEED,
        title="제목",
        blocks=(paragraph(),),
    )

    paths = repository.delete(draft_id)

    assert paths == (f"drafts/{draft_id}/{image_id}.png",)
    with pytest.raises(DraftNotFoundError):
        repository.get(draft_id)


def test_deleting_an_unknown_draft_is_refused(repository: SqlitePostDraftRepository) -> None:
    with pytest.raises(DraftNotFoundError):
        repository.delete(uuid4())
