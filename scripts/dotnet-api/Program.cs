using System.Reflection;
using System.Text.Json;

Assembly api = Assembly.LoadFrom(Path.GetFullPath(args[0]));
string Name(Type t) => t.IsArray ? Name(t.GetElementType()!) + "[]"
    : Nullable.GetUnderlyingType(t) is { } underlying ? Name(underlying) + "?"
    : t.IsGenericType ? t.Name.Split('`')[0] + "<" + string.Join(",", t.GetGenericArguments().Select(Name)) + ">"
    : t.Name;
var types = api.GetExportedTypes().Where(t => t.Namespace == "BonniePDF")
    .OrderBy(t => t.Name).ToDictionary(t => t.Name, t => new {
        enums = t.IsEnum ? Enum.GetNames(t) : null,
        properties = t.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0)
            .OrderBy(p => p.Name).ToDictionary(p => p.Name, p => new {
                type = Name(p.PropertyType), writable = p.SetMethod?.IsPublic == true
            })
    });
Console.Write(JsonSerializer.Serialize(types));
