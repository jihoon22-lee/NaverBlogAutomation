import { LOCAL_API_ORIGIN } from "./config";

const status = document.querySelector<HTMLParagraphElement>("#status");

if (status !== null) {
  status.dataset.apiOrigin = LOCAL_API_ORIGIN;
}
