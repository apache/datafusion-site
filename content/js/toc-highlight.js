/* Highlights the current section in the table of contents */

const tocLinks = document.querySelectorAll(".toc a");

function highlightToc() {
  let current;
  for (const link of tocLinks) {
    const heading = document.getElementById(link.hash.slice(1));
    if (heading && heading.getBoundingClientRect().top <= 70)
      current = link.hash;
  }
  tocLinks.forEach((link) =>
    link.classList.toggle("active", link.hash === current),
  );
}

window.addEventListener("scroll", highlightToc, { passive: true });
highlightToc();
