/**
 * Synthetic Naver-like markup for the page-script tests.
 *
 * Only synthetic content appears here; real article text, URLs, and account markup are never
 * committed.
 */

export function setBody(html: string): void {
  document.body.innerHTML = html;
}

export function modernPost(options: { body?: string; title?: string } = {}): string {
  const body = options.body ?? "합성 본문 문단입니다. 전시 관람 동선을 정리했습니다.";
  const title = options.title ?? "합성 전시 후기";
  return `
    <div class="blog_container">
      <div class="se-title-text"><span>${title}</span></div>
      <div class="se-main-container">
        <p>${body}</p>
      </div>
    </div>
  `;
}

export function legacyPost(options: { body?: string; title?: string } = {}): string {
  const body = options.body ?? "레거시 편집기로 작성한 합성 본문입니다.";
  const title = options.title ?? "레거시 합성 제목";
  return `
    <div class="post_wrap">
      <h1 class="pcol1">${title}</h1>
      <div id="postViewArea"><p>${body}</p></div>
    </div>
  `;
}

export function likeControl(
  options: { liked?: boolean | null; canonical?: boolean; withLayer?: boolean } = {},
): string {
  const liked = options.liked === undefined ? false : options.liked;
  const canonical = options.canonical ?? true;
  const pressed = liked === null ? "" : `aria-pressed="${liked ? "true" : "false"}"`;
  const face = `<a class="u_likeit_button _face" role="button" href="#" ${pressed}>공감</a>`;
  const layer = options.withLayer
    ? `<a class="u_likeit_list_button _button" data-type="like" href="#">공감</a>`
    : "";
  const inner = `<div class="my_reaction">${face}</div>${layer}`;
  const module = `<div class="u_likeit_list_module _reactionModule_BLOG">${inner}</div>`;
  return canonical ? `<div class="area_sympathy" id="area_sympathy123">${module}</div>` : module;
}

export function commentEditor(
  options: { value?: string; withSubmit?: boolean; disabledSubmit?: boolean } = {},
): string {
  const value = options.value ?? "";
  const submit =
    options.withSubmit === false
      ? ""
      : `<div class="u_cbox_upload"><button class="u_cbox_btn_upload"${
          options.disabledSubmit ? " disabled" : ""
        }>등록</button></div>`;
  return `
    <div class="u_cbox_write_wrap">
      <div class="u_cbox_write_area"><textarea class="u_cbox_text">${value}</textarea></div>
      ${submit}
    </div>
  `;
}

export function commentOpener(): string {
  return `<a class="btn_write_comment _naverCommentWriteBtn" href="#">댓글 쓰기</a>`;
}

export function publishedComment(text: string): string {
  return `
    <div class="u_cbox_comment_box">
      <span class="u_cbox_contents">${text}</span>
    </div>
  `;
}

export function neighborEntry(label = "서로이웃추가"): string {
  return `<a href="https://blog.naver.com/BuddyAddForm.naver?blogId=example">${label}</a>`;
}

export function neighborOptionForm(
  options: { checked?: boolean; withNext?: boolean } = {},
): string {
  const checked = options.checked === true ? " checked" : "";
  const next = options.withNext === false ? "" : `<button type="button">다음</button>`;
  return `
    <form id="buddyAddForm">
      <input type="radio" id="both_buddy" name="relation" value="both"${checked} />
      <label for="both_buddy">서로이웃</label>
      ${next}
    </form>
  `;
}

export function neighborApplicationForm(
  options: { message?: string; group?: "select" | "radio" | "none"; withNext?: boolean } = {},
): string {
  const message = options.message ?? "";
  const group =
    options.group === "select"
      ? `<select name="groupId"><option value="">선택</option><option value="1">기본 그룹</option></select>`
      : options.group === "radio"
        ? `<input type="radio" name="groupId" id="group1" value="1" /><label for="group1">기본 그룹</label>`
        : "";
  const next = options.withNext === false ? "" : `<button type="button">다음</button>`;
  return `
    <form name="buddyApplyFrm">
      ${group}
      <textarea id="message" name="message">${message}</textarea>
      ${next}
    </form>
  `;
}
