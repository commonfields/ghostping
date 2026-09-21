#[derive(Debug, Clone)]
pub struct TemplateInfo {
    pub name: &'static str,
    pub description: &'static str,
    pub tags: &'static [&'static str],
    pub author: &'static str,
}

pub const BUILTIN_TEMPLATES: &[TemplateInfo] = &[
    TemplateInfo {
        name: "rust-crate",
        description: "GEO optimization for open-source Rust crates and CLI tools",
        tags: &["rust", "cli", "open-source"],
        author: "ghostping-community",
    },
    TemplateInfo {
        name: "python-package",
        description: "GEO optimization for Python packages published to PyPI",
        tags: &["python", "pypi", "open-source"],
        author: "ghostping-community",
    },
    TemplateInfo {
        name: "saas-product",
        description: "GEO optimization for SaaS products and web applications",
        tags: &["saas", "product", "startup"],
        author: "ghostping-community",
    },
    TemplateInfo {
        name: "open-source",
        description: "Generic GEO optimization for any open-source project",
        tags: &["open-source", "github"],
        author: "ghostping-community",
    },
    TemplateInfo {
        name: "technical-blog",
        description: "GEO optimization for technical blogs and developer content",
        tags: &["blog", "content", "developer"],
        author: "ghostping-community",
    },
    TemplateInfo {
        name: "personal-brand",
        description: "GEO optimization for personal brands and indie hackers",
        tags: &["personal", "indie-hacker", "brand"],
        author: "ghostping-community",
    },
];

pub fn find_template(name: &str) -> Option<&'static TemplateInfo> {
    BUILTIN_TEMPLATES.iter().find(|t| t.name == name)
}

pub fn search_templates(query: &str) -> Vec<&'static TemplateInfo> {
    let q = query.to_lowercase();
    BUILTIN_TEMPLATES
        .iter()
        .filter(|t| {
            t.name.contains(q.as_str())
                || t.description.to_lowercase().contains(q.as_str())
                || t.tags.iter().any(|tag| tag.contains(q.as_str()))
        })
        .collect()
}
