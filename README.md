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

There are two ways to preview your blog post before publishing the site. You can
either locally build and test the site or you can use the auto staging feature
of the CI system. To locally build the site on your machine, follow the instructions below.

To use the staging feature of the CI system, push a branch that starts with
`site/` and create a PR to merge this branch into `main`. When you do so, it
will trigger a CI process that will build the site and push it to the branch
`asf-staging`. Once this completes, the ASF infrastructure will auto publish
this staged branch to https://datafusion.staged.apache.org/ It is important
to note that this staging feature only works for branches on the main repo.
If you are working on a forked repo, you will need to use the local approach
below.

The most recently run staging CI pipeline will be published to this site. If you
need to republish any branch, simply rerun the `Stage Site` workflow.

## Local Setup

To locally build and preview the site on your computer, run
```shell
make build
```

This will build the site using the [`ASF-Pelican`](https://github.com/apache/infrastructure-actions/tree/main/pelican) docker container.

Navigate in your web browser to [http://localhost:8000/blog](http://localhost:8000/blog) to view the live
website. In your terminal you can press Ctrl+C and rerun the last two commands
to rebuild and publish the site.

## Publish site

The site publishes using a GitHub action provided by the ASF Infrastructure team.
See the [ASF-Pelican](https://infra.apache.org/asf-pelican.html) site for most details
on how this process works.

To preview your site live, create a branch named `site/my-feature-x`. This should
auto-publish to https://datafusion.staged.apache.org/

When you are satisfied with the staged branch, merging into `main` should cause
the site to build via github actions and publish.

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

