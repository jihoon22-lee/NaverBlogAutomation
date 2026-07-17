"""Run public synthetic grounding cases through the real OpenAI adapter boundary."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from openai import OpenAI

from naver_blog_assistant.domain import (
    CandidateTone,
    CapturedPost,
    GenerationOutput,
)
from naver_blog_assistant.infrastructure.generators.openai import OpenAICommentGenerator


def _cases() -> list[dict[str, Any]]:
    loaded = json.loads(
        (Path(__file__).with_name("comment_cases.json")).read_text(encoding="utf-8")
    )
    assert isinstance(loaded, list)
    return loaded


def _response(
    case: dict[str, Any], *, bad: bool = False, ungrounded: bool = False
) -> dict[str, object]:
    details = "관련 없는 일반 내용" if ungrounded else " / ".join(case["required_details"])
    forbidden = case["forbidden_claims"][0] if bad else ""
    content = {
        "summary": f"{details}에 관한 글",
        "topics": [str(case["required_details"][0])],
        "candidates": [
            {
                "tone": tone.value,
                "comment": f"{details}이 인상적이네요. {forbidden}".strip(),
                "referenced_detail": details,
            }
            for tone in CandidateTone
        ],
    }
    return {
        "id": "resp_eval",
        "created_at": 0,
        "model": "gpt-5.6-terra",
        "object": "response",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "output": [
            {
                "id": "msg_eval",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps(content, ensure_ascii=False),
                        "annotations": [],
                    }
                ],
            }
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


def _run_adapter(
    case: dict[str, Any], *, bad: bool = False, ungrounded: bool = False
) -> GenerationOutput:
    client = OpenAI(
        api_key="synthetic-key",
        max_retries=0,
        http_client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json=_response(case, bad=bad, ungrounded=ungrounded))
            )
        ),
    )
    adapter = OpenAICommentGenerator(client=client)
    try:
        return adapter.generate(
            CapturedPost(
                source_url="https://blog.naver.com/synthetic/eval",
                title=case["title"],
                body=case["body"],
            )
        )
    finally:
        client.close()


def _assert_grounded(case: dict[str, Any], output: GenerationOutput) -> None:
    candidate_texts = [
        f"{candidate.comment} {candidate.referenced_detail}" for candidate in output.candidates
    ]
    evaluated = " ".join(
        (
            output.summary,
            *output.topics,
            *(candidate.comment for candidate in output.candidates),
            *(candidate.referenced_detail for candidate in output.candidates),
        )
    )
    missing = [detail for detail in case["required_details"] if detail not in evaluated]
    forbidden = [claim for claim in case["forbidden_claims"] if claim in evaluated]
    assert not missing, f"missing grounding details: {missing}"
    assert all(
        any(detail in candidate for detail in case["required_details"])
        for candidate in candidate_texts
    ), "each candidate must cite a required article detail"
    assert not forbidden, f"forbidden claims present: {forbidden}"


def test_synthetic_cases_run_through_adapter_and_are_grounded() -> None:
    cases = _cases()
    assert len(cases) >= 2
    assert len({case["id"] for case in cases}) == len(cases)
    for case in cases:
        assert not any(secret in case["body"] for secret in ("sk-proj-", "session_cookie="))
        _assert_grounded(case, _run_adapter(case))


def test_evaluator_rejects_forbidden_adapter_output() -> None:
    case = _cases()[0]
    with pytest.raises(AssertionError, match="forbidden claims"):
        _assert_grounded(case, _run_adapter(case, bad=True))


def test_evaluator_rejects_ungrounded_adapter_output() -> None:
    case = _cases()[0]
    with pytest.raises(AssertionError, match="missing grounding details"):
        _assert_grounded(case, _run_adapter(case, ungrounded=True))
