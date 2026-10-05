using System;
using System.Collections.Generic;
using System.Xml.Linq;
using GumBridge.Conversion;

namespace GumBridge.Infrastructure.Gum;

/// <summary>Native Gum screen XML; returns bytes for caller-owned isolated staging, never writes target paths.</summary>
public static class GumModelSerializer
{
    private static readonly XNamespace Xsi = "http://www.w3.org/2001/XMLSchema-instance";
    private static readonly XNamespace Xsd = "http://www.w3.org/2001/XMLSchema";

    public static string Serialize(GumScreen screen) => SerializeElement("ScreenSave", screen.Name, screen.Elements);

    public static string SerializeComponent(GumComponent component) => SerializeElement("ComponentSave", component.Name, component.Elements);

    private static string SerializeElement(string kind, string name, IReadOnlyList<GumElement> elements)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Element name required", nameof(name));
        var state = new XElement("State", new XElement("Name", "Default"));
        var root = new XElement(kind, new XAttribute(XNamespace.Xmlns + "xsd", Xsd), new XAttribute(XNamespace.Xmlns + "xsi", Xsi),
            new XElement("Name", name), kind == "ComponentSave" ? new XElement("BaseType", "Container") : null, state);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var element in elements)
        {
            if (!seen.Add(element.Name)) throw new ArgumentException("Duplicate Gum element name", nameof(elements));
            foreach (var value in element.Values)
                AddVariable(state, element.Name + "." + value.Name, value.Type, value.Value);
            if (element.Parent is not null) AddVariable(state, element.Name + ".Parent", "string", element.Parent);
            AddVariable(state, element.Name + ".Visible", "bool", element.Visible ? "true" : "false");
            root.Add(new XElement("Instance", new XElement("Name", element.Name), new XElement("BaseType", element.Type)));
        }
        return new XDocument(new XDeclaration("1.0", "utf-8", null), root).ToString(SaveOptions.DisableFormatting) + "\n";
    }

    private static void AddVariable(XElement state, string name, string type, string value) =>
        state.Add(new XElement("Variable", new XElement("Type", type), new XElement("Name", name),
            new XElement("Value", new XAttribute(Xsi + "type", "xsd:" + (type == "bool" ? "boolean" : type == "float?" ? "float" : type is "DimensionUnitType" or "PositionUnitType" or "HorizontalAlignment" or "VerticalAlignment" or "ChildrenLayout" ? "int" : type)), value),
            new XElement("SetsValue", "true")));
}
