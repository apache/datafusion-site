# Apache DataFusion Blog Content

This repository contains the Apache DataFusion blog at https://datafusion.apache.org/blog/

## Authoring blog posts

It is recommended to use one of the existing posts and follow the same format.
There are a couple of important impacts on the publishing:

- The filename should match the YYYY-MM-DD-brief-title.md format. During
    processing we parse these filenames to extract the date.
- Images should link to "/blog/images/image-path.png" and not to a relative
    path.

## Testing

There are two ways to preview your blog post before publishing it:

1. **Local preview** - Build and test the site on your own machine.
2. **CI auto-staging** - Use the ASF CI system to automatically build and stage the site for preview.

### Local Preview

To locally build and preview the site on your computer:

```shell
make
```

This will build the site using the [`ASF-Pelican`](https://github.com/apache/infrastructure-actions/tree/main/pelican) docker container.

Once the site is built, open your browser and navigate to:
[http://localhost:8000/blog](http://localhost:8000/blog)

You'll see a live preview of the site. If you make changes, stop the server with `Ctrl+C` and rerun `make` to rebuild and preview again.

### CI Auto-Staging

To use the auto-staging feature, push your changes to a branch that starts with `site/` (e.g., `site/my-post`).

This will trigger the CI system to:

1. Build the site from your `site/*` branch.
2. Output the result to a branch named `site/<name>-staging`.
3. Push that staging branch to the main repository.
4. ASF infrastructure will then publish the content to:
`https://datafusion-<branch>.staged.apache.org`

For example, pushing `site/blog-redesign` will result in:
https://datafusion-blog-redesign.staged.apache.org

Note that CI auto-staging only works on branches in the main `apache` repository.
If you're working in a fork, use the local preview method instead.

## Publish site

The site publishes using a GitHub action provided by the ASF Infrastructure team.
See the [ASF-Pelican](https://infra.apache.org/asf-pelican.html) site for most details
on how this process works.

Merging into `main` should cause the site to build via github actions and publish.

#### Check site status

The website is updated from the `asf-site` branch. You can check the status at 
[ASF Infra sitesource](https://infra-reports.apache.org/#sitesource)

## Updating Dependencies

The JavaScript and CSS files included in this repository are based on the
example from the [ASF Infra](https://github.com/apache/infrastructure-website)
and modified slightly for our purposes. If you need to update these, the core
libraries to use are

- [bootstrap](https://getbootstrap.com/) you can simply download the latest
    bundled minified version and css file. You will want to also include the
    associated `.map` file. This is an common library used to provide a host
    of useful JavaScript functions for websites.
- [highlight.js](https://highlightjs.org/) provides the code colorization
    for the blog posts, making them more readable. To generate a new highlight
    package, you can use the [generator tool](https://highlightjs.org/download).
    When you download this package, you will want to extract the full js file,
    not the minified file or you will not get all of the functionality you
    need.
- [font awesome](https://fontawesome.com/) provides a variety of improved
    fonts for readability. You can simply update the provided css files.
- In addition to these dependencies, we have some custom CSS files to improve
    the site layout. You can edit these files directly.

