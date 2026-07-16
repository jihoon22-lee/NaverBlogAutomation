"""Streamlit entry point for the comment-assistant application."""

from __future__ import annotations

import streamlit as st


def main() -> None:
    """Render the initial human-in-the-loop application shell."""
    st.set_page_config(page_title="Naver Blog Assistant", page_icon="💬")
    st.title("Naver Blog AI 댓글 작성 보조 도구")
    st.info("글 분석과 댓글 초안 생성을 지원하며, 네이버 등록은 사용자가 직접 수행합니다.")

    st.text_input("네이버 블로그 글 URL", placeholder="https://blog.naver.com/...")
    st.text_area("분석할 글 본문", height=260)
    st.button("댓글 후보 생성", disabled=True, help="다음 개발 단계에서 활성화됩니다.")


if __name__ == "__main__":
    main()
